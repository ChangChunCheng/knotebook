// Shared by `GET /api/notes`, `GET /api/favorites` and MCP `list_notes`/`search_notes`; trashed notes are always excluded (each branch has `deleted_at IS NULL`). The visibility semantics (owned ∪ shared ∪ grouped) must have one copy: drift in a second copy would be caught by no test. Four other visibility queries hand-write their group branch (different column sets): `candidates.ts`, `service.ts` `loadNoteAudience`, `links.ts` `fetchBacklinks`, `tx/write-links.ts`.
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, groups, notePlacements, noteShares, notes, users } from "../db/schema.js";
import { OWNER_PERMISSIONS, groupNotePermissions, roleFromGroupFlags, sharePermissions, type NoteAccess } from "./service.js";

/** Second `users` alias: this JOINs the editor, not the owner; always LEFT JOIN (no editor yet, or a deleted account). */
export const editor = alias(users, "editor");
/** Union selects must match column by column, so one shared definition. */
export const lastEditedSelection = {
  lastEditedAt: notes.lastEditedAt,
  lastEditedAgentLabel: notes.lastEditedAgentLabel,
  editorHandle: editor.handle,
};

/** `ownerHandle` is `sql<string | null>` because drizzle set operators need later branches assignable to the first (owned), and the grouped branch LEFT JOINs users. Built per call: builders are single-use. */
function baseColumns() {
  return {
    id: notes.id,
    title: notes.title,
    ownerId: notes.ownerId,
    slug: notes.slug,
    slugIsCustom: notes.slugIsCustom,
    prevSlug: notes.prevSlug,
    ownerHandle: sql<string | null>`${users.handle}`.as("owner_handle"),
    createdAt: notes.createdAt,
    updatedAt: notes.updatedAt,
    ...lastEditedSelection,
  };
}

/** owned/shared are always NULL (they structurally exclude group notes; a leftover share row on a group note must not leak the group name). */
function nullGroupColumns() {
  return {
    groupId: sql<string | null>`null::uuid`.as("group_id"),
    groupName: sql<string | null>`null::text`.as("group_name"),
    groupCanDelete: sql<boolean | null>`null::boolean`.as("group_can_delete"),
    groupCanManagePublicLink: sql<boolean | null>`null::boolean`.as("group_can_manage_public_link"),
  };
}
function groupColumns() {
  return {
    groupId: sql<string | null>`${notes.groupId}`.as("group_id"),
    groupName: sql<string | null>`${groups.name}`.as("group_name"),
    groupCanDelete: sql<boolean | null>`${groupRoles.canDelete}`.as("group_can_delete"),
    groupCanManagePublicLink: sql<boolean | null>`${groupRoles.canManagePublicLink}`.as("group_can_manage_public_link"),
  };
}

/** Not in `baseColumns()`: the shared branch must output the caller's own placement, not the owner's `folder_id`. */
function ownFolderColumn() {
  return { viewerFolderId: sql<string | null>`${notes.folderId}`.as("viewer_folder_id") };
}
function placementFolderColumn() {
  return { viewerFolderId: sql<string | null>`${notePlacements.folderId}`.as("viewer_folder_id") };
}

/**
 * The grouped `role` is a CASE on `can_edit`, same as `roleFromGroupFlags` (equivalence test). `shared` requires `group_id IS NULL` explicitly rather than relying on `owner_id <> $u` being false on NULL. Column order must be identical across branches (a union is positional). Builders are mutable and single-use, so every call builds fresh ones; don't `.where()` the result (it replaces, not ANDs, and the contamination is retroactive): pass `extraWhere`. `extra` takes only additional output columns. `and(cond, undefined)` is safe: drizzle drops undefined.
 */
export function visibleNoteBranches<E extends Record<string, SQL.Aliased>>(
  db: DbOrTx,
  userId: string,
  opts: { extraWhere?: SQL; extra?: E } = {},
) {
  const extra = (opts.extra ?? {}) as E;
  const owned = db
    .select({ ...baseColumns(), ...nullGroupColumns(), ...ownFolderColumn(), ...extra, role: sql<string>`'owner'`.as("role") })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(eq(notes.ownerId, userId), isNull(notes.deletedAt), opts.extraWhere));
  const shared = db
    .select({ ...baseColumns(), ...nullGroupColumns(), ...placementFolderColumn(), ...extra, role: noteShares.role })
    .from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .leftJoin(notePlacements, and(eq(notePlacements.noteId, notes.id), eq(notePlacements.userId, userId)))
    .where(and(isNull(notes.groupId), sql`${notes.ownerId} <> ${userId}`, isNull(notes.deletedAt), opts.extraWhere));
  const grouped = db
    .select({
      ...baseColumns(),
      ...groupColumns(),
      ...ownFolderColumn(),
      ...extra,
      role: sql<string>`case when ${groupRoles.canEdit} then 'editor' else 'viewer' end`.as("role"),
    })
    .from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .innerJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(sql`${notes.groupId} is not null`, isNull(notes.deletedAt), opts.extraWhere));
  return { owned, shared, grouped };
}

export function accessFromListRow(row: {
  role: string;
  groupId: string | null;
  groupCanDelete: boolean | null;
  groupCanManagePublicLink: boolean | null;
}): Pick<NoteAccess, "role" | "permissions"> {
  if (row.groupId !== null) {
    const flags = {
      canRead: true,
      canEdit: row.role === "editor",
      canDelete: row.groupCanDelete === true,
      canManagePublicLink: row.groupCanManagePublicLink === true,
    };
    return { role: roleFromGroupFlags(flags), permissions: groupNotePermissions(flags) };
  }
  if (row.role === "owner") return { role: "owner", permissions: OWNER_PERMISSIONS };
  const share = row.role === "editor" ? "editor" : "viewer";
  return { role: share, permissions: sharePermissions(share) };
}
