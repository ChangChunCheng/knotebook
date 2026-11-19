import type { FolderPermissionsDto } from "@knotebook/shared";
import type { FolderSpace } from "./space.js";

export interface FolderRoleFlags { canRead: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean }

export function folderPermissions(space: FolderSpace, userId: string, flags: FolderRoleFlags | null): FolderPermissionsDto | null {
  switch (space.kind) {
    case "personal":
      return space.ownerId === userId ? { manage: true, deleteNotes: true, createNote: true } : null;
    case "shared":
      return space.ownerId === userId ? { manage: true, deleteNotes: true, createNote: false } : null;
    case "group":
      if (flags === null || !flags.canRead) return null;
      return { manage: flags.canEdit, deleteNotes: flags.canDelete, createNote: flags.canCreate && flags.canEdit };
  }
}
