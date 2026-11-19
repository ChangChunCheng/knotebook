import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { NotePermissions, Role } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, noteShares, notes } from "../db/schema.js";

// pg throws on a malformed uuid string (a 500 via the global handler), so path params are checked first. Also reused for `DELETE …/shares/:userId`.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everyone who can see the note now (owner, shares, members with the read flag); empty for a missing note or bad id. The delete gate must tell everyone who could see the note that it's gone without revealing the id to others, so this list is captured before the move transaction. Must not be called with the pool inside a transaction. Doesn't filter `deleted_at` (`noteIsLive` decides liveness). */
export async function loadNoteAudience(db: DbOrTx, noteId: string): Promise<Set<string>> {
  if (!UUID_RE.test(noteId)) return new Set();

  const [note] = await db
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  if (!note) return new Set();

  const shares = await db
    .select({ userId: noteShares.userId })
    .from(noteShares)
    .where(eq(noteShares.noteId, noteId));
  const members =
    note.groupId === null
      ? []
      : await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
          .where(eq(groupMembers.groupId, note.groupId));
  const ids = [note.ownerId, ...shares.map(one => one.userId), ...members.map(one => one.userId)];
  return new Set(ids.filter((id): id is string => id !== null));
}

export interface NoteGroupFlags {
  canRead: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManagePublicLink: boolean;
}

/** `can_edit ⇒ can_read` (DB `group_roles_read_implied_chk`), so checking edit first never yields write-without-read. SQL twin: the CASE in `visibleNoteBranches` (compared in `groups-v2-visibility.test.ts`). */
export function roleFromGroupFlags(r: { canRead: boolean; canEdit: boolean }): Role {
  if (r.canEdit) return "editor";
  if (r.canRead) return "viewer";
  return "none";
}

export const NO_PERMISSIONS: NotePermissions = Object.freeze({
  read: false, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false,
});
export const OWNER_PERMISSIONS: NotePermissions = Object.freeze({
  read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true,
});

export function sharePermissions(role: "editor" | "viewer"): NotePermissions {
  return { ...NO_PERMISSIONS, read: true, edit: role === "editor" };
}

export function groupNotePermissions(f: NoteGroupFlags): NotePermissions {
  if (!f.canRead) return NO_PERMISSIONS;
  return {
    read: true,
    edit: f.canEdit,
    delete: f.canDelete,
    manageShares: false,
    managePublicLink: f.canManagePublicLink,
    changeSlug: f.canManagePublicLink,
    moveToGroup: false,
  };
}

export interface NoteAccess {
  role: Role;
  ownerId: string | null;
  /** The `group_id` read at decision time: single-note paths compare it with the fetched row (a mismatch means ownership changed in between, e.g. a move just committed: reread once, then 404); PATCH's `patchSlugInTx` uses it as a scope condition. */
  groupId: string | null;
  permissions: NotePermissions;
}

const NO_ACCESS: NoteAccess = Object.freeze({ role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS });

/** Shared by EXPLAIN tests and the implementation. Leftover share rows on group notes grant nothing (matches the list's shared branch `group_id IS NULL`). Trashed notes always resolve to none. `noteId` must already pass `UUID_RE`. */
export function accessQuery(db: DbOrTx, userId: string, noteId: string) {
  return db
    .select({
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      shareRole: noteShares.role,
      roleId: groupRoles.id,
      canRead: groupRoles.canRead,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId), isNull(notes.groupId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .limit(1);
}

export function trashedAccessQuery(db: DbOrTx, userId: string, noteId: string) {
  return db
    .select({
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      shareRole: noteShares.role,
      roleId: groupRoles.id,
      canRead: groupRoles.canRead,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId), isNull(notes.groupId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
}

export type AccessRow = Awaited<ReturnType<typeof accessQuery>>[number];

/** `tx/` files can't contain the literal `resolveNoteAccess(` (structure guard), so they use this with `accessQuery`; an undefined row → none. */
export function noteAccessFromRow(row: AccessRow | undefined, userId: string): NoteAccess {
  if (!row) return NO_ACCESS;

  if (row.groupId === null) {
    if (row.ownerId === userId) return { role: "owner", ownerId: row.ownerId, groupId: null, permissions: OWNER_PERMISSIONS };
    if (row.shareRole === "editor" || row.shareRole === "viewer") {
      return { role: row.shareRole, ownerId: row.ownerId, groupId: null, permissions: sharePermissions(row.shareRole) };
    }
    return NO_ACCESS;
  }

  if (row.roleId === null) return NO_ACCESS;
  const flags: NoteGroupFlags = {
    canRead: row.canRead ?? false,
    canEdit: row.canEdit ?? false,
    canDelete: row.canDelete ?? false,
    canManagePublicLink: row.canManagePublicLink ?? false,
  };
  const role = roleFromGroupFlags(flags);
  if (role === "none") return NO_ACCESS;
  return { role, ownerId: null, groupId: row.groupId, permissions: groupNotePermissions(flags) };
}

/** Group-note roles are never `owner`; a site admin who isn't a member has no privileges on them. In a transaction, pass `tx`. */
export async function resolveNoteAccess(db: DbOrTx, userId: string, noteId: string): Promise<NoteAccess> {
  if (!UUID_RE.test(noteId)) return NO_ACCESS;
  return noteAccessFromRow((await accessQuery(db, userId, noteId))[0], userId);
}

export function trashRightFromRow(row: AccessRow | undefined, userId: string): boolean {
  if (!row) return false;
  if (row.groupId === null) return row.ownerId === userId;
  if (row.roleId === null) return false;
  return row.canEdit === true && row.canDelete === true;
}

export async function resolveTrashedNoteAccess(db: DbOrTx, userId: string, noteId: string): Promise<boolean> {
  if (!UUID_RE.test(noteId)) return false;
  return trashRightFromRow((await trashedAccessQuery(db, userId, noteId))[0], userId);
}

export async function noteIsLive(db: DbOrTx, noteId: string): Promise<boolean> {
  if (!UUID_RE.test(noteId)) return false;
  const rows = await db.select({ one: sql`1` }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt))).limit(1);
  return rows.length > 0;
}

/** Signature frozen: hot-path callers (collab/server, ai, links) get correct results for group notes unchanged. */
export async function resolveRole(db: DbOrTx, userId: string, noteId: string): Promise<Role> {
  return (await resolveNoteAccess(db, userId, noteId)).role;
}
