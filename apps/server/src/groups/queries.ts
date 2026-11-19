/**
 * Invariant: every group keeps at least one built-in admin. Transactions changing `group_members` / `role_id` call `lockGroup()` first and then count
 * with a separate statement, `countAdmins()`: under READ COMMITTED the new statement only gets a fresh snapshot once the lock is held
 * (without the lock, two concurrent demotions both see an admin left and end with zero).
 * Don't merge them into one statement or switch to REPEATABLE READ.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  GROUP_ROLE_NAME_MAX, normalizeRoleName, type BuiltinGroupRole, type GroupDto, type GroupRoleDto, type GroupRoleFlags,
} from "@knotebook/shared";
import type { DbOrTx, Tx } from "../db/tx.js";
import { groupMembers, groupRoles, groups, notes } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { hasUnstorableChar } from "../oauth/storable.js";

export type { DbOrTx, Tx } from "../db/tx.js";

/** Identical for non-member, nonexistent and malformed id. */
export const GROUP_NOT_FOUND_MESSAGE = "No group with that id.";
/** Identical for non-UUID, non-member and non-admin. */
export const NOT_ADMIN_MESSAGE = "The transfer target must be an admin of this group.";
export const GROUP_NAME_MAX = 80;

/**
 * Rejects NUL and lone surrogates (`hasUnstorableChar`): NUL in a `text` column is 22021 (a 500); the pg driver silently turns a lone surrogate into U+FFFD, so the name would be silently corrupted.
 * Length counts code points (DB `length()`): 80 single-code-point emoji fit exactly, composed emoji take several; see `docs/api.md`. Returns the trimmed name, or null.
 */
export function validateGroupName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_NAME_MAX ? name : null;
}

function roleColumns() {
  return {
    roleId: groupRoles.id,
    builtin: groupRoles.builtin,
    roleName: groupRoles.name,
    canRead: groupRoles.canRead,
    canCreate: groupRoles.canCreate,
    canEdit: groupRoles.canEdit,
    canDelete: groupRoles.canDelete,
    canManagePublicLink: groupRoles.canManagePublicLink,
    canManageMembers: groupRoles.canManageMembers,
    canManageGroup: groupRoles.canManageGroup,
    memberCount: sql<number>`(select count(*)::int from ${groupMembers} as gm2 where gm2.role_id = ${groupRoles.id})`,
  };
}

interface RoleColumnsRow {
  roleId: string | null;
  builtin: string | null;
  roleName: string | null;
  canRead: boolean | null;
  canCreate: boolean | null;
  canEdit: boolean | null;
  canDelete: boolean | null;
  canManagePublicLink: boolean | null;
  canManageMembers: boolean | null;
  canManageGroup: boolean | null;
  memberCount: number | null;
}

export function toGroupRoleDto(r: RoleColumnsRow): GroupRoleDto | null {
  if (r.roleId === null) return null;
  return {
    id: r.roleId,
    builtin: (r.builtin ?? null) as BuiltinGroupRole | null,
    name: r.roleName,
    permissions: {
      read: r.canRead === true,
      create: r.canCreate === true,
      edit: r.canEdit === true,
      delete: r.canDelete === true,
      managePublicLink: r.canManagePublicLink === true,
      manageMembers: r.canManageMembers === true,
      manageGroup: r.canManageGroup === true,
    },
    memberCount: r.memberCount ?? 0,
  };
}

export function toGroupDto(row: { id: string; name: string; createdAt: Date; autoVersions: boolean } & RoleColumnsRow, isSiteAdmin: boolean): GroupDto {
  const myRole = toGroupRoleDto(row);
  return {
    id: row.id,
    name: row.name,
    myRole,
    canManageMembers: (myRole?.permissions.manageMembers ?? false) || isSiteAdmin,
    canManageGroup: (myRole?.permissions.manageGroup ?? false) || isSiteAdmin,
    createdAt: row.createdAt.toISOString(),
    autoVersions: row.autoVersions,
  };
}

export interface GroupAccess {
  role: GroupRoleDto | null;
  manageMembers: boolean;
  manageGroup: boolean;
}

export function groupWithMyRoleQuery(db: DbOrTx, groupId: string, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, autoVersions: groups.autoVersions, ...roleColumns() })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(groups.id, groupId))
    .limit(1);
}

/** null → 404 for malformed id, nonexistent group and non-member non-admin alike. A member without the read flag still sees the group. */
export async function groupAccess(db: DbOrTx, groupId: string, user: { id: string; isAdmin: boolean }): Promise<GroupAccess | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [row] = await groupWithMyRoleQuery(db, groupId, user.id);
  if (!row) return null;
  const dto = toGroupDto(row, user.isAdmin);
  if (dto.myRole === null && !user.isAdmin) return null;
  return { role: dto.myRole, manageMembers: dto.canManageMembers, manageGroup: dto.canManageGroup };
}

export async function lockGroup(tx: Tx, groupId: string): Promise<boolean> {
  const rows = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("update");
  return rows.length > 0;
}

/** Must be a separate statement after `lockGroup`. Custom roles with all seven flags don't count. */
export async function countAdmins(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupRoles.builtin, "admin")));
  return row?.n ?? 0;
}

export async function roleInGroup(db: DbOrTx, groupId: string, roleId: string) {
  const [row] = await db
    .select({ id: groupRoles.id, builtin: groupRoles.builtin })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
  return row;
}

export async function builtinRoleId(db: DbOrTx, groupId: string, builtin: BuiltinGroupRole): Promise<string> {
  const [row] = await db
    .select({ id: groupRoles.id })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.builtin, builtin)))
    .limit(1);
  if (!row) throw new Error(`群組 ${groupId} 缺內建 ${builtin} 角色（S9 被打破）`);
  return row.id;
}

export function listMyGroupsQuery(db: DbOrTx, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, autoVersions: groups.autoVersions, ...roleColumns() })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(groupMembers.userId, userId))
    .orderBy(
      sql`case ${groupRoles.builtin} when 'admin' then 0 when 'member' then 1 else 2 end`,
      asc(groups.name),
      asc(groups.id),
    );
}

export function listRolesQuery(db: DbOrTx, groupId: string) {
  return db
    .select(roleColumns())
    .from(groupRoles)
    .where(eq(groupRoles.groupId, groupId))
    .orderBy(
      sql`case ${groupRoles.builtin} when 'admin' then 0 when 'member' then 1 else 2 end`,
      sql`lower(${groupRoles.name})`,
      asc(groupRoles.id),
    );
}

export function groupNoteIdsQuery(db: DbOrTx, groupId: string) {
  return db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, groupId));
}

/** Rejects NUL and lone surrogates (`hasUnstorableChar`), then trim → NFC, 1..40 code points (`group_roles_name_len_chk`); invalid → null. Returns the normalized value; store it so `' reader '` and `Reader` collide under the `lower()` index. Reserved names are checked separately (409, not 400). */
export function validateRoleName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = normalizeRoleName(raw);
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_ROLE_NAME_MAX ? name : null;
}

export function roleFlagValues(f: GroupRoleFlags) {
  return {
    canRead: true as const,
    canCreate: f.create,
    canEdit: f.edit,
    canDelete: f.delete,
    canManagePublicLink: f.managePublicLink,
    canManageMembers: f.manageMembers,
    canManageGroup: f.manageGroup,
  };
}

export function roleByIdQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select(roleColumns())
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
}

export function roleHolderIdsQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.roleId, roleId)));
}
