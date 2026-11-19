import type { GroupDto, NoteDto } from "@knotebook/shared";
import type { FolderIndex } from "@/components/sidebar/folder-index";
import { noteBucket } from "@/components/sidebar/tree";
import { canCreateAndEdit } from "@/lib/group-role";

export interface CreateTarget {
  groupId?: string;
  folderId?: string;
}

/** Null hides the button; never falls back to the root, to avoid creating somewhere the user did not expect. */
export function createTargetFor(note: NoteDto, ctx: { groups: readonly GroupDto[]; folders: FolderIndex }): CreateTarget | null {
  const bucket = noteBucket(note, new Set(ctx.groups.map((group) => group.id)));
  if (bucket.kind === "shared") return null;
  let target: CreateTarget = {};
  if (bucket.kind === "group") {
    const group = ctx.groups.find((item) => item.id === bucket.groupId);
    if (group === undefined || !canCreateAndEdit(group)) return null;
    target = { groupId: bucket.groupId };
  }
  if (note.folderId === null) return target;
  const folder = ctx.folders.byId.get(note.folderId);
  if (folder === undefined || !folder.permissions.createNote) return null;
  return { ...target, folderId: folder.id };
}
