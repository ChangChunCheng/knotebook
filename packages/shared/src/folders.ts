// 資料夾（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.3、§5.11）。
// `NoteDto.folderId`／`sizeBytes` 在 T4 加、`TrashItemDto.folderPath` 在 T7 加（各自與 server 同一個 task，避免 shared 先改、server 編不過）。

export const FOLDER_NAME_MAX = 80;
export const FOLDER_DEPTH_MAX = 5;          // 根層資料夾為第 1 層（D2）
export const FOLDERS_PER_SPACE_MAX = 1000;

export type FolderKind = "personal" | "group" | "shared";
export type FolderSpaceDto = { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string };

export interface FolderPermissionsDto {
  manage: boolean;      // 建子資料夾、改名、搬移、刪除（無活筆記時）
  deleteNotes: boolean; // 子樹有活筆記時能不能刪（群組＝can_delete；個人恆真；shared 恆真＝只移除）
  createNote: boolean;  // 在此建立筆記（personal 恆真；group＝create ∧ edit；shared 恆 false）
}

export interface FolderDto { id: string; name: string; parentId: string | null; space: FolderSpaceDto; createdAt: string; permissions: FolderPermissionsDto }
export interface FolderListDto { folders: FolderDto[] }
export interface FolderDeleteResultDto { trashedNoteIds: string[]; deletedFolderIds: string[] }
