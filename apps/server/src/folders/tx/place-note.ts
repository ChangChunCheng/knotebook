/** Shared placements lock the note FOR KEY SHARE so the owner's writes aren't blocked. */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notePlacements, notes } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { accessQuery, noteAccessFromRow } from "../../notes/service.js";
import {
  FOLDER_NOT_FOUND_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PLACE_FORBIDDEN_MESSAGE,
} from "../messages.js";
import { sameFolderSpace, type FolderSpace } from "../space.js";
import { folderAccessInTx, lockFolderInTx, lockGroupsKeyShareInTx } from "./lock.js";

export type PlaceMode = { kind: "owned" } | { kind: "group"; groupId: string } | { kind: "shared" };

export interface PlaceNoteInput {
  by: string;
  noteId: string;
  folderId: string | null;
  mode: PlaceMode;
}

export function placeTargetSpace(mode: PlaceMode, by: string): FolderSpace {
  switch (mode.kind) {
    case "owned":
      return { kind: "personal", ownerId: by };
    case "group":
      return { kind: "group", groupId: mode.groupId };
    case "shared":
      return { kind: "shared", ownerId: by };
  }
}

export async function placeNoteInTx(tx: Tx, input: PlaceNoteInput, hook?: GroupTestHook): Promise<{ changed: boolean }> {
  const { by, noteId, folderId, mode } = input;
  const noteNotFound = (): TxAbort => new TxAbort(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  const folderNotFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const hookCtx: GroupHookCtx = {
    noteId,
    ...(folderId !== null ? { folderId } : {}),
    ...(mode.kind === "group" ? { groupId: mode.groupId } : {}),
  };

  // Group gone = the note left its group (transferred): the note takes precedence → not_found.
  if (mode.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [mode.groupId]);
    if (!present.has(mode.groupId)) throw noteNotFound();
  }
  // Folder before note, the same direction as folder deletion (folder → notes), so the two can't deadlock.
  const folder = folderId !== null ? await lockFolderInTx(tx, folderId, "key share") : undefined;
  const [row] = await tx
    .select({ id: notes.id, folderId: notes.folderId })
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .for(mode.kind === "shared" ? "key share" : "update");
  if (!row) throw noteNotFound();

  const access = noteAccessFromRow((await accessQuery(tx, by, noteId))[0], by);
  if (access.role === "none") throw noteNotFound();
  const allowed = mode.kind === "owned"
    ? access.role === "owner"
    : mode.kind === "group"
      ? access.groupId === mode.groupId && access.permissions.edit
      : (access.role === "editor" || access.role === "viewer") && access.groupId === null;
  if (!allowed) throw new TxAbort(403, "forbidden", NOTE_PLACE_FORBIDDEN_MESSAGE);

  if (folderId !== null) {
    if (!folder) throw folderNotFound();
    const target = await folderAccessInTx(tx, by, folder);
    if (target === null) throw folderNotFound();
    if (!sameFolderSpace(target.space, placeTargetSpace(mode, by))) throw new TxAbort(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
  }
  await hook?.("note-folder-locked", hookCtx);

  if (mode.kind !== "shared") {
    if (row.folderId === folderId) return { changed: false };
    await tx.update(notes).set({ folderId }).where(eq(notes.id, noteId));
    return { changed: true };
  }
  if (folderId === null) {
    const gone = await tx
      .delete(notePlacements)
      .where(and(eq(notePlacements.userId, by), eq(notePlacements.noteId, noteId)))
      .returning({ noteId: notePlacements.noteId });
    return { changed: gone.length > 0 };
  }
  const written = await tx
    .insert(notePlacements)
    .values({ userId: by, noteId, folderId })
    .onConflictDoUpdate({
      target: [notePlacements.userId, notePlacements.noteId],
      set: { folderId: sql`excluded.folder_id` },
      setWhere: sql`${notePlacements.folderId} is distinct from excluded.folder_id`,
    })
    .returning({ noteId: notePlacements.noteId });
  return { changed: written.length > 0 };
}
