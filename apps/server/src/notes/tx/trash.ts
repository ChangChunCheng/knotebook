/**
 * `trashNotesInTx` is the only writer of non-NULL `deleted_at` and `restoreNotesInTx` the only one clearing it; neither touches `updated_at` (its meaning is title/URL change). Trashing writes `trash_folder_path` in the same UPDATE; restore rebuilds the path only if the folder is gone and always clears the snapshot; neither touches child tables or files. Gates, file deletion and `onNotesRestored` are the caller's job outside the transaction.
 * Note locks always go through `lockNotes`: `FOR UPDATE` by id ascending (same order as `deleteNotesInTx`, so multiple ids don't cycle), then re-judge. Trashing only changes non-key columns, which a plain UPDATE takes as `FOR NO KEY UPDATE` and which doesn't conflict with the `FOR KEY SHARE` of uploads/copy source/indexing; the explicit FOR UPDATE is what serializes them.
 * Permission rechecks inside the transaction are written as `noteAccessFromRow((await accessQuery(tx, …))[0], …)`: the structure guard forbids the literal single-note authorization calls in `tx/` files.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { notes } from "../../db/schema.js";
import { ensureFolderPathInTx } from "../../folders/tx/ensure-path.js";
import { lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "../../folders/tx/lock.js";
import { folderSpaceLockKey, noteFolderSpace, sortedSpaceLockKeys, type FolderSpace } from "../../folders/space.js";
import { folderPathJsonSql, NOTES_FOLDER_ID } from "../../folders/sql.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { accessQuery, noteAccessFromRow, trashedAccessQuery, trashRightFromRow } from "../service.js";
import { deleteNotesInTx } from "./delete-notes.js";

/** `ids`: UUID-checked, lowercased and deduped by the caller. */
export interface TrashIdsInput { ids: readonly string[]; by: string }
export interface TrashNotesOutcome { trashed: string[]; notFound: string[]; forbidden: string[] }
export interface TrashBatchOutcome { done: string[]; skipped: TrashSkipDto[] }
export interface TrashRestoreInput extends TrashIdsInput {
  groupIds: readonly string[]; spaces: readonly FolderSpace[]; lockTimeoutMs: number;
}

async function lockNotes(tx: Tx, ids: readonly string[]) {
  const rows = await tx
    .select({
      id: notes.id, deletedAt: notes.deletedAt, ownerId: notes.ownerId, groupId: notes.groupId,
      folderId: notes.folderId, trashFolderPath: notes.trashFolderPath,
    })
    .from(notes)
    .where(inArray(notes.id, [...ids]))
    .orderBy(asc(notes.id))
    .for("update");
  return new Map(rows.map(({ id, ...rest }) => [id, rest]));
}
/** Inferred from `lockNotes` rather than restated (a guard freezes the count of `deletedAt:` literals). */
type LockedNote = Awaited<ReturnType<typeof lockNotes>> extends Map<string, infer V> ? V : never;

/** Callers must authorize and open each note's collab gate (`beforeNoteDeleted`) outside the transaction; this only re-judges after locking. The classification isn't an existence oracle (invisible and missing are both `notFound`). Classification: none (trashed or missing included) → `notFound`, no delete right → `forbidden`; empty ids issue nothing. */
export async function trashNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashNotesOutcome> {
  const out: TrashNotesOutcome = { trashed: [], notFound: [], forbidden: [] };
  if (input.ids.length === 0) return out;
  await lockNotes(tx, input.ids);
  await hook?.("note-trash-locked", { noteId: input.ids[0]! });

  const ok: string[] = [];
  for (const id of [...input.ids].sort()) {
    const access = noteAccessFromRow((await accessQuery(tx, input.by, id))[0], input.by);
    if (access.role === "none") out.notFound.push(id);
    else if (!access.permissions.delete) out.forbidden.push(id);
    else ok.push(id);
  }
  if (ok.length === 0) return out;
  const rows = await tx
    .update(notes)
    // Path snapshot read without the folder structure lock (a slightly stale name is harmless); folder_id is left as is.
    .set({ deletedAt: sql`now()`, deletedBy: input.by, trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) })
    .where(and(inArray(notes.id, ok), isNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  out.trashed = ok.filter(id => hit.has(id));
  return out;
}

async function classifyTrashed(tx: Tx, input: TrashIdsInput, locked: Map<string, LockedNote>): Promise<{ ok: string[]; skipped: TrashSkipDto[] }> {
  const ok: string[] = [];
  const skipped: TrashSkipDto[] = [];
  for (const id of input.ids) {
    const row = locked.get(id);
    if (row === undefined) skipped.push({ id, reason: "not_found" });
    else if (row.deletedAt === null) skipped.push({ id, reason: "not_in_trash" });
    else if (!trashRightFromRow((await trashedAccessQuery(tx, input.by, id))[0], input.by)) skipped.push({ id, reason: "not_found" });
    else ok.push(id);
  }
  return { ok, skipped };
}

/**
 * Callers must pre-check with `resolveTrashedNoteAccess` and pass only ids the user has trash rights on: the classification order (missing → `not_found`, alive → `not_in_trash`, then trash right) is an existence oracle for arbitrary ids.
 * Lock order: groups KEY SHARE for `groupIds` (by id) → structure locks for `spaces` (by key) → `lockNotes`; both lists are pre-read by the caller outside the transaction. The rebuilt-folder INSERT (parent FK KS) comes after the note locks: the space structure lock is already held, and any transaction taking FU on that space's folders takes it first. If a note's space lock key isn't among those held (ownership changed after the pre-read, e.g. a transfer), the path isn't rebuilt and the note stays at the new space's root. Rebuilding ignores depth/count limits; permission = trash right (personal: owner; group: `can_edit ∧ can_delete`), a superset of manage rights; an intact original folder is left alone; `done`/`skipped` keep input order.
 */
export async function restoreNotesInTx(tx: Tx, input: TrashRestoreInput, hook?: GroupTestHook): Promise<TrashBatchOutcome> {
  if (input.ids.length === 0) return { done: [], skipped: [] };
  await lockGroupsKeyShareInTx(tx, input.groupIds);
  await lockFolderSpacesInTx(tx, input.spaces, { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { noteId: input.ids[0]! } });
  const held = new Set(sortedSpaceLockKeys(input.spaces));
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-restore-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped };
  for (const id of [...ok].sort()) {
    const row = locked.get(id)!;
    const path = row.trashFolderPath;
    if (row.folderId !== null || !Array.isArray(path) || path.length === 0 || !path.every(s => typeof s === "string")) continue;
    const space = noteFolderSpace(row);
    if (!held.has(folderSpaceLockKey(space))) continue;
    const leaf = await ensureFolderPathInTx(tx, space, path.map(s => s.normalize("NFC")), input.by);
    await tx.update(notes).set({ folderId: leaf }).where(and(eq(notes.id, id), isNotNull(notes.deletedAt)));
  }
  const rows = await tx
    .update(notes)
    .set({ deletedAt: null, deletedBy: null, trashFolderPath: null })
    .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  return { done: ok.filter(id => hit.has(id)), skipped };
}

/** Same pre-check requirement as `restoreNotesInTx`. */
export async function purgeTrashedNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashBatchOutcome & { uploadIds: string[] }> {
  if (input.ids.length === 0) return { done: [], skipped: [], uploadIds: [] };
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-purge-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped, uploadIds: [] };
  const uploadIds = await deleteNotesInTx(tx, ok);
  return { done: ok, skipped, uploadIds };
}

/** Notes trashed strictly before `now() − retentionDays`, ordered by `deleted_at, id`, at most `limit`, timed in the DB. `SKIP LOCKED`: don't wait for rows being restored or purged by hand; the next round handles them. */
export async function purgeExpiredBatchInTx(
  tx: Tx,
  input: { retentionDays: number; limit: number },
  hook?: GroupTestHook,
): Promise<{ noteIds: string[]; uploadIds: string[] }> {
  const rows = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNotNull(notes.deletedAt), sql`${notes.deletedAt} < now() - make_interval(days => ${input.retentionDays})`))
    .orderBy(asc(notes.deletedAt), asc(notes.id))
    .limit(input.limit)
    .for("update", { skipLocked: true });
  await hook?.("trash-purge-locked", rows[0] ? { noteId: rows[0].id } : {});
  if (rows.length === 0) return { noteIds: [], uploadIds: [] };
  const noteIds = rows.map(r => r.id);
  return { noteIds, uploadIds: await deleteNotesInTx(tx, noteIds) };
}
