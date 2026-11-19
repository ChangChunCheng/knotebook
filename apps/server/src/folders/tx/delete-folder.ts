/**
 * Transaction body for deleting a folder. Takes only `tx`, plain data and the test hook; the collab gates are opened by the
 * service layer before the transaction and released after it.
 * Order: (group space) groups KEY SHARE → structure lock → subtree folders FOR UPDATE (by id) → recheck visibility and manage permission →
 * - shared: `DELETE` the root (subfolders and placements CASCADE), no trash;
 * - personal/group: lock every note in the subtree by id in one statement (any state) → live notes without an opened gate → 409 →
 *   trash live notes in batches of `DELETE_FOLDER_TRASH_CHUNK` via `trashNotesInTx` (`forbidden` → 403, `notFound` → 409; all or nothing) →
 *   refresh the path snapshot of trashed notes in the subtree → `DELETE` the root (subfolders CASCADE, notes' `folder_id` SET NULL).
 * The subtree is always selected by predicate (`subtreeFolderIdsSql`), never as an id array inside `IN`. Failures throw `TxAbort`.
 * `onlyIfEmpty` (no extra locks): after the recheck, a subtree larger than the root → 409 `folder_not_empty`; a shared root
 * with placements → 409; a live locked note in personal/group → 409 (checked before the gate check). Trashed notes don't count as content.
 * Callers must use READ COMMITTED (see `lock.ts`).
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { FolderDeleteResultDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders, notePlacements, notes } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { trashNotesInTx } from "../../notes/tx/trash.js";
import {
  FOLDER_CONTENT_CHANGED_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_NOT_EMPTY_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
} from "../messages.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../space.js";
import { folderPathJsonSql, NOTES_FOLDER_ID, subtreeFolderIdsSql } from "../sql.js";
import { folderAccessInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "./lock.js";

export interface DeleteFolderInput {
  by: string;
  /** Folder id and space pre-read outside the transaction; the id is lowercase. */
  folderId: string;
  space: FolderSpace;
  /** Live note ids (ascending) pre-read outside the transaction, whose gates are already open. */
  gatedNoteIds: readonly string[];
  lockTimeoutMs: number;
  onlyIfEmpty?: boolean;
}

/** Ids per `trashNotesInTx` batch (stays under the protocol's parameter limit). */
export const DELETE_FOLDER_TRASH_CHUNK = 1000;

export async function deleteFolderInTx(tx: Tx, input: DeleteFolderInput, hook?: GroupTestHook): Promise<FolderDeleteResultDto> {
  const { space } = input;
  const notFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const changed = (): TxAbort => new TxAbort(409, "conflict", FOLDER_CONTENT_CHANGED_MESSAGE);
  const notEmpty = (): TxAbort => new TxAbort(409, "folder_not_empty", FOLDER_NOT_EMPTY_MESSAGE);
  const onlyIfEmpty = input.onlyIfEmpty === true;
  const hookCtx: GroupHookCtx = { folderId: input.folderId, ...(space.kind === "group" ? { groupId: space.groupId } : {}) };

  if (space.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [space.groupId]);
    if (!present.has(space.groupId)) throw notFound();
  }
  await lockFolderSpacesInTx(tx, [space], { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx });

  const subtree = await tx
    .select()
    .from(folders)
    .where(sql`${folders.id} in (${subtreeFolderIdsSql(input.folderId)})`)
    .orderBy(asc(folders.id))
    .for("update");
  const root = subtree.find(f => f.id === input.folderId);
  if (!root || !sameFolderSpace(folderSpaceOfRow(root), space)) throw notFound();
  const access = await folderAccessInTx(tx, input.by, root);
  if (access === null) throw notFound();
  if (!access.permissions.manage) throw new TxAbort(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  const deletedFolderIds = subtree.map(f => f.id);
  // Every write that puts something into the subtree (placement, create/copy into a folder, rebuild from path) first takes KEY SHARE or the structure lock on these folders, so emptiness can't change between this check and the DELETE.
  if (onlyIfEmpty && subtree.length > 1) throw notEmpty();

  if (space.kind === "shared") {
    if (onlyIfEmpty) {
      const placed = await tx.select({ one: sql`1` }).from(notePlacements).where(eq(notePlacements.folderId, root.id)).limit(1);
      if (placed.length > 0) throw notEmpty();
    }
    await tx.delete(folders).where(eq(folders.id, root.id));
    return { trashedNoteIds: [], deletedFolderIds };
  }

  // One statement locks live and trashed notes by id; the WHERE is re-evaluated after lock waits, so a note just moved out of the subtree isn't locked.
  const locked = await tx
    .select({ id: notes.id, live: sql<boolean>`${notes.deletedAt} is null` })
    .from(notes)
    .where(sql`${notes.folderId} in (${subtreeFolderIdsSql(root.id)})`)
    .orderBy(asc(notes.id))
    .for("update");
  await hook?.("folder-delete-notes-locked", hookCtx);

  const gated = new Set(input.gatedNoteIds);
  const live = locked.filter(n => n.live).map(n => n.id);
  if (onlyIfEmpty && live.length > 0) throw notEmpty();
  // A live note without an opened gate (it entered the subtree after the pre-read): moving it to the trash would let connected users keep writing, so reject the whole delete.
  if (live.some(id => !gated.has(id))) throw changed();

  for (let i = 0; i < live.length; i += DELETE_FOLDER_TRASH_CHUNK) {
    const out = await trashNotesInTx(tx, { ids: live.slice(i, i + DELETE_FOLDER_TRASH_CHUNK), by: input.by });
    if (out.forbidden.length > 0) throw new TxAbort(403, "folder_delete_blocked", FOLDER_DELETE_BLOCKED_MESSAGE);
    // This batch is already locked in this transaction, so notFound can only mean a role changed after the recheck; skipping it would let the DELETE below SET NULL a live note to the root.
    if (out.notFound.length > 0) throw changed();
  }

  // Trashed notes in the subtree (including ones just trashed) get their path snapshot refreshed to the path at delete time, before `folder_id` is SET NULL.
  await tx
    .update(notes)
    .set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) })
    .where(and(sql`${notes.folderId} in (${subtreeFolderIdsSql(root.id)})`, isNotNull(notes.deletedAt)));
  await tx.delete(folders).where(eq(folders.id, root.id));
  return { trashedNoteIds: live, deletedFolderIds };
}
