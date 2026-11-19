import type { GroupDto, NoteDto } from "@knotebook/shared";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";

/**
 * Note fixtures for the select mode of the regular tab (shared by tests).
 * Permission objects always expand the triple from `@/test/fixtures` and then override.
 */

/** The single NoteDto base: add new NoteDto fields here only. Defaults to a personal note (role owner). */
export function baseNote(o: { id: string; title: string } & Partial<NoteDto>): NoteDto {
  return {
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `note-${o.id}`,
    ownerHandle: "tester",
    groupId: null,
    slugIsCustom: false,
    prevSlug: null,
    lastEdited: null,
    group: null,
    permissions: { ...OWNER_PERMS },
    folderId: null,
    ...o,
  };
}

export function personalNote(o: { id: string; title: string } & Partial<NoteDto>): NoteDto {
  return baseNote({ role: "owner", permissions: { ...OWNER_PERMS }, ...o });
}

export function sharedNote(o: { id: string; title: string; role?: "editor" | "viewer" } & Partial<NoteDto>): NoteDto {
  const role = o.role ?? "editor";
  return baseNote({
    ownerId: "u9",
    ownerHandle: "someone",
    permissions: { ...(role === "viewer" ? VIEWER_PERMS : EDITOR_PERMS) },
    ...o,
    role,
  });
}

/**
 * Group note: no personal owner; `edit` / `delete` default to true (derived from the role flags); when `edit === false` the role is viewer.
 * `manageShares` / `moveToGroup` are false (#175); override `permissions` yourself when a test needs to tell them apart.
 */
export function groupNote(o: { id: string; title: string; group: GroupDto; edit?: boolean; delete?: boolean } & Partial<NoteDto>): NoteDto {
  const { group, edit = true, delete: canDelete = true, ...rest } = o;
  return baseNote({
    ownerId: null,
    ownerHandle: null,
    role: edit ? "editor" : "viewer",
    groupId: group.id,
    group: { id: group.id, name: group.name },
    permissions: { ...VIEWER_PERMS, edit, delete: canDelete },
    ...rest,
  });
}
