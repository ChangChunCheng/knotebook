/** Folder spaces and structure-lock keys. Pure data, no DB access. */
import type { FolderSpaceDto } from "@knotebook/shared";

export type FolderSpace = { kind: "personal"; ownerId: string } | { kind: "shared"; ownerId: string } | { kind: "group"; groupId: string };

/** `knotebook.folders:<kind>:<lowercase id>`. The prefix mirrors `knotebook.storage:` in `storage/space.ts` so the two lock key spaces never collide. */
export function folderSpaceLockKey(space: FolderSpace): string {
  const id = space.kind === "group" ? space.groupId : space.ownerId;
  return `knotebook.folders:${space.kind}:${id.toLowerCase()}`;
}

/** Deduplicated and sorted; this is the lock acquisition order. */
export function sortedSpaceLockKeys(spaces: readonly FolderSpace[]): string[] {
  return [...new Set(spaces.map(folderSpaceLockKey))].sort();
}

/** Throws on combinations that violate the `folders_space_chk` constraint. */
export function folderSpaceOfRow(row: { kind: string; ownerId: string | null; groupId: string | null }): FolderSpace {
  if (row.kind === "group" && row.groupId !== null && row.ownerId === null) return { kind: "group", groupId: row.groupId };
  if ((row.kind === "personal" || row.kind === "shared") && row.ownerId !== null && row.groupId === null) {
    return { kind: row.kind, ownerId: row.ownerId };
  }
  throw new Error(`folderSpaceOfRow: kind／owner_id／group_id 不一致（kind=${row.kind}）`);
}

/** Folder space a note belongs to; `notes_owner_xor_group_chk` guarantees exactly one of owner/group is set. */
export function noteFolderSpace(note: { ownerId: string | null; groupId: string | null }): FolderSpace {
  if (note.groupId !== null) return { kind: "group", groupId: note.groupId };
  if (note.ownerId !== null) return { kind: "personal", ownerId: note.ownerId };
  throw new Error("noteFolderSpace: owner_id 與 group_id 皆為 NULL（違反 notes_owner_xor_group_chk）");
}

export function sameFolderSpace(a: FolderSpace, b: FolderSpace): boolean {
  return folderSpaceLockKey(a) === folderSpaceLockKey(b);
}

/** Whether a new note's folder fits its target: a group folder needs the same groupId (compared lowercase), a personal folder takes no groupId, a shared folder never applies. */
export function newNoteFolderConsistent(space: FolderSpace, groupId: string | undefined): boolean {
  return space.kind === "group"
    ? groupId !== undefined && groupId.toLowerCase() === space.groupId
    : space.kind === "personal" && groupId === undefined;
}

/** Public shape: personal/shared omit `ownerId` (only the owner can see them). */
export function toFolderSpaceDto(space: FolderSpace): FolderSpaceDto {
  return space.kind === "group" ? { kind: "group", groupId: space.groupId } : { kind: space.kind };
}
