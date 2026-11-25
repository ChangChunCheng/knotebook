import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteVersions, notes, type VersionEditorJson } from "../../db/schema.js";

export type { VersionEditorJson };
export type NoteVersionRow = typeof noteVersions.$inferSelect;

export const spaceKeyOf = (r: { ownerId: string | null; groupId: string | null }): string =>
  r.ownerId !== null ? `u:${r.ownerId}` : `g:${r.groupId}`;

/** CHECK `notes_version_pending_chk`: with nothing pending, editors must be `[]` and the reference fingerprint NULL. */
export const PENDING_CLEARED: { versionPendingAt: null; versionPendingEditors: VersionEditorJson[]; versionPendingRefFingerprint: null } = {
  versionPendingAt: null,
  versionPendingEditors: [],
  versionPendingRefFingerprint: null,
};

export function dedupeEditors(list: readonly VersionEditorJson[]): VersionEditorJson[] {
  const seen = new Set<string>();
  const out: VersionEditorJson[] = [];
  for (const e of list) {
    const k = JSON.stringify([e.user_id, e.agent_label]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ user_id: e.user_id, agent_label: e.agent_label });
  }
  return out;
}

/** Reads `version_base_seq` in the same DELETE, so it excludes the base only at statement read time: a `setVersionBase` committing during the DELETE is missed (snapshot); accepted. Column names are table-qualified literals (drizzle renders `${table.col}` bare in single-table statements). */
export const notBaseVersionSql = (noteId: string): SQL =>
  sql`note_versions.seq is distinct from (select notes.version_base_seq from notes where notes.id = ${noteId})`;

export interface CutVersionInput {
  noteId: string;
  kind: "auto" | "manual";
  /** Already `normalizeVersionName`'d; null = unnamed. */
  name: string | null;
  editors: VersionEditorJson[];
  expectBaseFingerprint: string | null;
  expectSpaceKey: string;
  loadFingerprint: string | null;
  vacuumFingerprint: string;
  /** Called once in the first synchronous section after the lock is acquired. A throw means the fingerprint couldn't be computed. */
  capture: () => { fp: string; ydoc: Uint8Array };
  /** Only affects "same base → manual": keeps a user-given name (`COALESCE`). */
  keepExistingName: boolean;
  dueBy?: Date;
}

export type CutAbortReason =
  | { kind: "note-deleted" }
  | { kind: "clean" }
  | { kind: "stale"; baseFingerprint: string | null; spaceKey: string }
  | { kind: "fingerprint-failed"; cause: unknown }
  | { kind: "not-due" };

/** Rejections throw: drizzle only ROLLBACKs on throw. */
export class VersionCutAbort extends Error {
  constructor(readonly reason: CutAbortReason) {
    super(`version cut aborted: ${reason.kind}`);
    this.name = "VersionCutAbort";
  }
}

export async function cutVersionInTx(tx: Tx, input: CutVersionInput): Promise<{ row: NoteVersionRow; upgraded: boolean; fp: string }> {
  const [note] = await tx
    .select({
      baseSeq: notes.versionBaseSeq,
      baseFingerprint: notes.versionBaseFingerprint,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      pendingAt: notes.versionPendingAt,
      pendingEditors: notes.versionPendingEditors,
    })
    .from(notes)
    // Trashed = unreadable → note-deleted (`readVersionMeta` deliberately unchanged).
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("update");
  // From here to the next await is the first synchronous section after the lock: take fp and ydoc here and use only this copy.
  let snap: { fp: string; ydoc: Uint8Array } | null = null;
  let captureError: unknown;
  if (note) {
    try {
      snap = input.capture();
    } catch (err) {
      captureError = err;
    }
  }
  if (!note) throw new VersionCutAbort({ kind: "note-deleted" });
  if (snap === null) throw new VersionCutAbort({ kind: "fingerprint-failed", cause: captureError });
  const spaceKey = spaceKeyOf(note);
  // A different space key means a move interleaved.
  if (note.baseFingerprint !== input.expectBaseFingerprint || spaceKey !== input.expectSpaceKey) {
    throw new VersionCutAbort({ kind: "stale", baseFingerprint: note.baseFingerprint, spaceKey });
  }
  // pending_at NULL or later → not-due (a persist landed between the scan and this transaction).
  if (input.dueBy !== undefined && (note.pendingAt === null || note.pendingAt.getTime() > input.dueBy.getTime())) {
    throw new VersionCutAbort({ kind: "not-due" });
  }
  const { fp, ydoc } = snap;
  if (note.baseFingerprint !== null && note.baseSeq !== null && fp === note.baseFingerprint) {
    if (input.kind === "auto") throw new VersionCutAbort({ kind: "clean" });
    const [upgraded] = await tx
      .update(noteVersions)
      .set(
        input.name === null
          ? { kind: "manual" }
          : input.keepExistingName
            ? { kind: "manual", name: sql<string>`coalesce(${noteVersions.name}, ${input.name})` }
            : { kind: "manual", name: input.name },
      )
      .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, note.baseSeq)))
      .returning();
    if (upgraded) {
      await tx.update(notes).set(PENDING_CLEARED).where(eq(notes.id, input.noteId));
      return { row: upgraded, upgraded: true, fp };
    }
    // Base row vanished (READ COMMITTED race, or a direct SQL delete): the UPDATE hits 0 rows → fall back to the no-base rule and point the base at the new version, so the new row's `base_seq` doesn't reference a deleted one.
  }
  if (input.kind === "auto" && note.baseFingerprint === null) {
    const dirty = (input.loadFingerprint === null || fp !== input.loadFingerprint) && fp !== input.vacuumFingerprint;
    if (!dirty) throw new VersionCutAbort({ kind: "clean" });
  }
  const [maxRow] = await tx
    .select({ maxSeq: sql<number | null>`max(${noteVersions.seq})` })
    .from(noteVersions)
    .where(eq(noteVersions.noteId, input.noteId));
  const [counted] = await tx
    .update(notes)
    .set({ versionCounter: sql`${notes.versionCounter} + 1` })
    .where(eq(notes.id, input.noteId))
    .returning({ seq: notes.versionCounter });
  const seq = counted!.seq;
  const maxSeq = maxRow?.maxSeq ?? null;
  let baseSeq = note.baseSeq !== null && note.baseSeq !== maxSeq ? note.baseSeq : null;
  let baseVersionId: string | null = null;
  if (baseSeq !== null) {
    // Base row already deleted: "continued from" must not point at a missing version → both columns null.
    // Take base_version_id from this row, not notes.version_base_version_id (NULL on old data).
    const [baseRow] = await tx
      .select({ id: noteVersions.id })
      .from(noteVersions)
      .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, baseSeq)))
      .limit(1);
    if (baseRow) baseVersionId = baseRow.id;
    else baseSeq = null;
  }
  const editors = dedupeEditors([...note.pendingEditors, ...input.editors]);
  const [row] = await tx
    .insert(noteVersions)
    .values({ noteId: input.noteId, seq, ydoc: Buffer.from(ydoc), kind: input.kind, name: input.name, editors, baseSeq, baseVersionId })
    .returning();
  await tx
    .update(notes)
    .set({ versionBaseSeq: seq, versionBaseFingerprint: fp, versionBaseVersionId: row!.id, ...PENDING_CLEARED })
    .where(eq(notes.id, input.noteId));
  return { row: row!, upgraded: false, fp };
}

/** Move (`{ noteId }`) or transfer (`{ groupId }`, call before `group_id` changes) when history isn't kept: clears versions, numbering, base and pending; creates none; the caller already holds the notes' `FOR UPDATE`. */
export async function resetNoteVersionsInTx(tx: Tx, target: { noteId: string } | { groupId: string }): Promise<void> {
  const noteWhere = "noteId" in target ? eq(notes.id, target.noteId) : eq(notes.groupId, target.groupId);
  const versionWhere =
    "noteId" in target
      ? eq(noteVersions.noteId, target.noteId)
      : sql`note_versions.note_id in (select notes.id from notes where notes.group_id = ${target.groupId})`;
  await tx.delete(noteVersions).where(versionWhere);
  await tx.update(notes).set({ versionCounter: 0, versionBaseSeq: null, versionBaseFingerprint: null, versionBaseVersionId: null, ...PENDING_CLEARED }).where(noteWhere);
}

/** Move that keeps history: versions, numbering and base stay; only the pending state goes, so personal-period editors aren't listed on the group's first automatic version. */
export async function clearPendingVersionStateInTx(tx: Tx, noteId: string): Promise<void> {
  await tx.update(notes).set(PENDING_CLEARED).where(eq(notes.id, noteId));
}
