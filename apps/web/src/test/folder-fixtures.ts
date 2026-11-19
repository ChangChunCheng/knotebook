import type { FolderDto, FolderListDto, FolderPermissionsDto, FolderSpaceDto } from "@knotebook/shared";


export const FOLDER_LIST_EMPTY: FolderListDto = { folders: [] };

const PERSONAL: FolderSpaceDto = { kind: "personal" };

function defaultPermissions(space: FolderSpaceDto): FolderPermissionsDto {
  if (space.kind === "shared") return { manage: true, deleteNotes: true, createNote: false };
  return { manage: true, deleteNotes: true, createNote: true };
}

export function folderDto(o: { id: string; name: string; parentId?: string | null; space?: FolderSpaceDto } & Partial<FolderDto>): FolderDto {
  const space = o.space ?? PERSONAL;
  return {
    parentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    permissions: defaultPermissions(space),
    ...o,
    space,
  };
}

export function groupFolder(o: {
  id: string;
  name: string;
  groupId: string;
  parentId?: string | null;
  edit?: boolean;
  delete?: boolean;
  create?: boolean;
}): FolderDto {
  const { groupId, edit = true, delete: canDelete = true, create = true, ...rest } = o;
  return folderDto({
    ...rest,
    space: { kind: "group", groupId },
    permissions: { manage: edit, deleteNotes: canDelete, createNote: create && edit },
  });
}

export function sharedFolder(o: { id: string; name: string; parentId?: string | null }): FolderDto {
  return folderDto({ ...o, space: { kind: "shared" } });
}

export function folderChain(prefix: string, depth: number, space: FolderSpaceDto = PERSONAL): FolderDto[] {
  return Array.from({ length: depth }, (_, i) =>
    folderDto({ id: `${prefix}${i + 1}`, name: `${prefix}${i + 1}`, parentId: i === 0 ? null : `${prefix}${i}`, space }),
  );
}
