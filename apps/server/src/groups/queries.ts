/**
 * #103, #175: group query builders and in-transaction helpers. Routes are in `routes/groups.ts`; transaction bodies in `groups/tx/*`.
 *
 * **Invariant: every group keeps at least one member holding the built-in admin role.** Any transaction that changes
 * `group_members` rows or their `role_id` first calls `lockGroup()` (`SELECT … FROM groups WHERE id=$g FOR UPDATE`) and only then
 * counts with a **separate statement**, `countAdmins()`: under READ COMMITTED a later arrival gets a fresh snapshot for the new
 * statement only after it obtains the lock (without the lock, two concurrent demotions could both pass and leave 0 admins).
 * Don't merge the lock and the count into one statement, and don't switch to REPEATABLE READ.
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

/** 404 `not_found` message for group routes; non-member, nonexistent and malformed id must produce byte-identical responses. */
export const GROUP_NOT_FOUND_MESSAGE = "No group with that id.";
/** 409 `not_admin` message for transfer-on-delete (#175); non-UUID, non-member and non-admin must produce byte-identical responses. */
export const NOT_ADMIN_MESSAGE = "The transfer target must be an admin of this group.";
export const GROUP_NAME_MAX = 80;

/**
 * Rejects NUL and lone surrogates first (`hasUnstorableChar`): NUL in a `text` column is 22021 (a 500), and a lone surrogate
 * would be silently replaced by U+FFFD when the pg driver encodes UTF-8. Then trims; length counts **code points** (same unit
 * as the DB `length()`), so 80 single-code-point emoji fit but composed emoji (flags, skin tones, ZWJ sequences) take several
 * code points each; see `docs/api.md`. Returns the trimmed name, or null if invalid.
 */
export function validateGroupName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_NAME_MAX ? name : null;
}

/** Role columns plus the number of members holding the role (correlated subquery). Built per call because drizzle builders are single-use. */
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

/** Role columns → DTO; null when the LEFT JOIN found no role (non-member). */
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

/** `GroupDto`: both `canManage*` flags = role flag OR site admin (member or not). */
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
  /** The caller's role in the group; null for a non-member (only possible for a site admin). */
  role: GroupRoleDto | null;
  manageMembers: boolean;
  manageGroup: boolean;
}

/** One group plus the caller's role; shared by `groupAccess` and the `POST`/`PATCH /api/groups…` responses. */
export function groupWithMyRoleQuery(db: DbOrTx, groupId: string, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, autoVersions: groups.autoVersions, ...roleColumns() })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(groups.id, groupId))
    .limit(1);
}

/**
 * The caller's visibility and manage rights for a group. null → always 404 (malformed id, nonexistent group, or non-member who isn't
 * a site admin); the three are indistinguishable. **A member without the read flag still sees the group itself.**
 */
export async function groupAccess(db: DbOrTx, groupId: string, user: { id: string; isAdmin: boolean }): Promise<GroupAccess | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [row] = await groupWithMyRoleQuery(db, groupId, user.id);
  if (!row) return null;
  const dto = toGroupDto(row, user.isAdmin);
  if (dto.myRole === null && !user.isAdmin) return null;
  return { role: dto.myRole, manageMembers: dto.canManageMembers, manageGroup: dto.canManageGroup };
}

/** Row lock for admin-count transactions (their first step). Returns false if the group doesn't exist (caller throws 404). */
export async function lockGroup(tx: Tx, groupId: string): Promise<boolean> {
  const rows = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("update");
  return rows.length > 0;
}

/** Members holding the **built-in admin** role (a custom role with all seven flags doesn't count). **Must be a separate statement after `lockGroup`.** */
export async function countAdmins(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupRoles.builtin, "admin")));
  return row?.n ?? 0;
}

/** A role of this group (`roleId` already passed `UUID_RE`); undefined if it belongs to another group (→ 404 `role_not_found`). */
export async function roleInGroup(db: DbOrTx, groupId: string, roleId: string) {
  const [row] = await db
    .select({ id: groupRoles.id, builtin: groupRoles.builtin })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
  return row;
}

/** Id of a built-in role. Each group has exactly one admin and one member role (the unique index caps it at one; group creation creates both). */
export async function builtinRoleId(db: DbOrTx, groupId: string, builtin: BuiltinGroupRole): Promise<string> {
  const [row] = await db
    .select({ id: groupRoles.id })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.builtin, builtin)))
    .limit(1);
  if (!row) throw new Error(`群組 ${groupId} 缺內建 ${builtin} 角色（S9 被打破）`);
  return row.id;
}

/**
 * `GET /api/groups`: the caller's groups, ordered by the caller's role (built-in admin → built-in member → custom, same CASE as
 * `listRolesQuery`), then name, then id. Built, not executed, so the route and the EXPLAIN test share one query shape.
 * The sidebar groups tab lists groups in this order.
 */
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

/**
 * `GET /api/groups/:id/roles`: built-in admin, built-in member, then the rest by `lower(name)`, `id`. Visible to any member
 * and to non-member site admins (same authorization as `GET …/members`).
 */
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

/** Ids of all notes in the group (kick list when members move or change role). Uses `notes_group_slug_idx` (leading column `group_id`). */
export function groupNoteIdsQuery(db: DbOrTx, groupId: string) {
  return db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, groupId));
}

/**
 * #175: custom role name. Rejects NUL and lone surrogates (`hasUnstorableChar`, like `validateGroupName`), then trim → NFC;
 * length 1..40 code points (same unit as the DB `group_roles_name_len_chk`). Invalid → null. Reserved names are checked separately
 * by `isReservedRoleName` (409, not 400). Returns the **normalized** value: store this, so `' reader '` and `Reader` collide under the `lower()` index.
 */
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

/** One role (with `memberCount`), same row shape as `listRolesQuery`; a role of another group → empty array. */
export function roleByIdQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select(roleColumns())
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
}

/** Members holding this role (kick list for `updateRoleInTx`/`deleteRoleInTx`). */
export function roleHolderIdsQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.roleId, roleId)));
}
