import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import type * as Y from "yjs";
import { MAX_BACKLINKS, MAX_LINK_TARGETS, extractLinkTargets, type BacklinkDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, noteLinks, noteShares, notes, users } from "../db/schema.js";
import { isForeignKeyViolation, isTransientTransactionError } from "../db/pg-errors.js";
import { writeLinksInTx, type WriteLinksInput } from "./tx/write-links.js";

export type NormalizeLinkTargetsResult = { ok: true; targets: string[] } | { ok: false };

/** Self-link removal and dedup happen before the `MAX_LINK_TARGETS` check (zod's max is only a coarse pre-gate). Lowercase before comparing (#240): `note_links` is a uuid column, so an uppercase own id would otherwise pass the self filter and become a self-link, and case variants would each take a slot. */
export function normalizeLinkTargets(sourceNoteId: string, rawTargetIds: string[]): NormalizeLinkTargetsResult {
  const self = sourceNoteId.toLowerCase();
  const deduped = [...new Set(rawTargetIds.map(targetId => targetId.toLowerCase()))].filter(targetId => targetId !== self);
  if (deduped.length > MAX_LINK_TARGETS) return { ok: false };
  return { ok: true, targets: deduped };
}

export type WriteNoteLinksParams = WriteLinksInput;

export interface WriteNoteLinksHooks {
  beforeLinkWrite?: () => Promise<void>;
}

export type WriteNoteLinksOutcome = "applied" | "noop" | "busy";

async function attemptOnce(db: Db, params: WriteNoteLinksParams, hooks: WriteNoteLinksHooks): Promise<"applied" | "noop"> {
  return db.transaction(tx => writeLinksInTx(tx, params, hooks.beforeLinkWrite));
}

/** An FK violation (a target deleted concurrently) retries once: `attemptOnce` reruns the authorization and drops it. 40001/40P01 → `"busy"` without a server-side retry, to avoid amplifying conflicts. */
export async function writeNoteLinks(db: Db, params: WriteNoteLinksParams, hooks: WriteNoteLinksHooks = {}): Promise<WriteNoteLinksOutcome> {
  try {
    return await attemptOnce(db, params, hooks);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      try {
        return await attemptOnce(db, params, hooks);
      } catch (err2) {
        if (isTransientTransactionError(err2)) return "busy";
        throw err2;
      }
    }
    if (isTransientTransactionError(err)) return "busy";
    throw err;
  }
}

export async function syncLinksFromDoc(
  deps: { db: Db; log: { warn(o: object, m: string): void } },
  p: { sourceNoteId: string; userId: string; clock: number } & ({ doc: Y.Doc } | { targets: string[] }),
): Promise<void> {
  // The self-link filter runs before the slice so self-links don't take slots; case-sensitive here, `normalizeLinkTargets` converges the final set.
  const deduped = ("targets" in p ? p.targets : extractLinkTargets(p.doc)).filter(t => t !== p.sourceNoteId);
  const trimmed = deduped.slice(0, MAX_LINK_TARGETS);
  if (trimmed.length < deduped.length) deps.log.warn({ noteId: p.sourceNoteId, kept: trimmed.length, dropped: deduped.length - trimmed.length }, "wikilink 目標超過 MAX_LINK_TARGETS，已截斷");
  const norm = normalizeLinkTargets(p.sourceNoteId, trimmed);
  if (!norm.ok) return;
  // Last step after content and note_ai_edits are persisted: a throw here would turn a fully successful write into a 500, and AI clients retry 500s (applying the edit twice). So failures only warn; the wikilink index lags until the next change (known-limitations). Copy likewise.
  try {
    const outcome = await writeNoteLinks(deps.db, { sourceNoteId: p.sourceNoteId, userId: p.userId, targetIds: norm.targets, clock: p.clock });
    if (outcome !== "applied") deps.log.warn({ noteId: p.sourceNoteId, outcome }, "note_links 未更新（CAS 落敗或忙碌）");
  } catch (err) {
    deps.log.warn({ noteId: p.sourceNoteId, err }, "note_links 寫入失敗，索引暫時落後（內容與紀錄已成功）");
  }
}

/** One SQL with the reader predicates inline, not `resolveRole` per source (N+1, and risks leaking existence/title). `union()` not `unionAll` so a source matching two branches dedupes. The `id DESC` tie-break is required: batch-inserted fixtures share `updated_at` and LIMIT would be nondeterministic. */
export async function fetchBacklinks(db: Db, targetNoteId: string, userId: string): Promise<BacklinkDto[]> {
  const columns = () => ({
    id: notes.id,
    title: notes.title,
    slug: notes.slug,
    ownerHandle: sql<string | null>`${users.handle}`.as("owner_handle"),
    groupId: notes.groupId,
    updatedAt: notes.updatedAt,
  });
  const ownedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), eq(notes.ownerId, userId), isNull(notes.deletedAt)));

  const sharedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), isNull(notes.groupId), isNull(notes.deletedAt)));

  const groupedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), isNull(notes.deletedAt)));

  const rows = await union(ownedSelect, sharedSelect, groupedSelect)
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(MAX_BACKLINKS);

  return rows.map(row => ({ id: row.id, title: row.title, slug: row.slug, ownerHandle: row.ownerHandle, groupId: row.groupId }));
}
