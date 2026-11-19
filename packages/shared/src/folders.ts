export const FOLDER_NAME_MAX = 80;
export const FOLDER_DEPTH_MAX = 5;          // root-level folders are depth 1
export const FOLDERS_PER_SPACE_MAX = 1000;

export type FolderKind = "personal" | "group" | "shared";
export type FolderSpaceDto = { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string };

export interface FolderPermissionsDto {
  manage: boolean;      // create subfolders, rename, move; delete when the subtree has no live notes
  deleteNotes: boolean; // may delete the folder when its subtree has live notes (group = can_delete; personal always true; shared always true, it only removes)
  createNote: boolean;  // create a note here (personal always true; group = create AND edit; shared always false)
}

export interface FolderDto { id: string; name: string; parentId: string | null; space: FolderSpaceDto; createdAt: string; permissions: FolderPermissionsDto }
export interface FolderListDto { folders: FolderDto[] }
export interface FolderDeleteResultDto { trashedNoteIds: string[]; deletedFolderIds: string[] }
