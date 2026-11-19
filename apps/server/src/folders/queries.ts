/**
 * Folder visibility and listing. Visibility and permissions are derived in one place, `folderAccessOf`,
 * so invisible and nonexistent folders look the same (null).
 */
import { and, asc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { FolderDto, FolderPermissionsDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { folders, groupMembers, groupRoles, groups } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { folderPermissions, type FolderRoleFlags } from "./permissions.js";
import { folderSpaceOfRow, toFolderSpaceDto, type FolderSpace } from "./space.js";
import { folderPathJsonSql } from "./sql.js";

export type FolderRow = typeof folders.$inferSelect;

export interface FolderAccess {
  folder: FolderRow;
  space: FolderSpace;
  /** Group folders: the caller's role flags (null for non-members). Always null for personal/shared. */
  flags: FolderRoleFlags | null;
  permissions: FolderPermissionsDto;
}

/** The single derivation of visibility and permissions; null = not visible. */
export function folderAccessOf(folder: FolderRow, flags: FolderRoleFlags | null, userId: string): FolderAccess | null {
  const space = folderSpaceOfRow(folder);
  const permissions = folderPermissions(space, userId, flags);
  return permissions === null ? null : { folder, space, flags, permissions };
}

/** Folder row plus the caller's role flags (LEFT JOIN; personal/shared rows have a NULL `group_id`, so the join never matches). */
function accessColumns() {
  return {
    folder: folders,
    roleId: groupRoles.id,
    canRead: groupRoles.canRead,
    canCreate: groupRoles.canCreate,
    canEdit: groupRoles.canEdit,
    canDelete: groupRoles.canDelete,
  };
}

/** Not locked; limit 1. `folderId` must already have passed `UUID_RE`. */
export function folderAccessQuery(db: DbOrTx, userId: string, folderId: string) {
  return db
    .select(accessColumns())
    .from(folders)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, folders.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(folders.id, folderId))
    .limit(1);
}

export type FolderAccessRow = Awaited<ReturnType<typeof folderAccessQuery>>[number];

export function folderAccessFromRow(row: FolderAccessRow | undefined, userId: string): FolderAccess | null {
  if (!row) return null;
  const flags: FolderRoleFlags | null = row.roleId === null
    ? null
    : { canRead: row.canRead === true, canCreate: row.canCreate === true, canEdit: row.canEdit === true, canDelete: row.canDelete === true };
  return folderAccessOf(row.folder, flags, userId);
}

/** Non-UUID or invisible → null (same shape as nonexistent). */
export async function resolveFolderAccess(db: DbOrTx, userId: string, folderId: string): Promise<FolderAccess | null> {
  if (!UUID_RE.test(folderId)) return null;
  const [row] = await folderAccessQuery(db, userId, folderId.toLowerCase());
  return folderAccessFromRow(row, userId);
}

export function toFolderDto(row: FolderRow, permissions: FolderPermissionsDto): FolderDto {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    space: toFolderSpaceDto(folderSpaceOfRow(row)),
    createdAt: row.createdAt.toISOString(),
    permissions,
  };
}

/**
 * Visibility predicate shared by both list queries: owner (personal/shared) or group member with `can_read`.
 * Needs the same LEFT JOINs as `folderAccessQuery`.
 */
function visibleFolderWhere(userId: string): SQL {
  return or(eq(folders.ownerId, userId), and(isNotNull(groupMembers.userId), eq(groupRoles.canRead, true)))!;
}

/**
 * `GET /api/folders`. Throws if the SQL filter selects a row that `folderAccessOf` hides: the two encode one visibility
 * rule, so a mismatch is a bug, and failing is better than leaking a folder or silently dropping one.
 */
export async function listVisibleFolders(db: DbOrTx, userId: string): Promise<FolderDto[]> {
  const rows = await db
    .select(accessColumns())
    .from(folders)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, folders.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(visibleFolderWhere(userId))
    .orderBy(
      asc(folders.kind),
      sql`coalesce(${folders.groupId}, ${folders.ownerId})`,
      sql`${folders.parentId} asc nulls first`,
      sql`lower(${folders.name})`,
      asc(folders.id),
    );
  const accesses = rows.map(row => folderAccessFromRow(row, userId));
  const hidden = accesses.filter(a => a === null).length;
  // The message omits folder ids; the error log keeps only the count.
  if (hidden > 0) throw new Error(`listVisibleFolders: SQL 篩選與 folderAccessOf 不一致（${hidden} 列）`);
  return accesses.map(a => toFolderDto(a!.folder, a!.permissions));
}

export type FolderKind = FolderSpace["kind"];
export const FOLDER_KINDS: readonly FolderKind[] = ["group", "personal", "shared"];
/** Keyset key; `spaceId` is the group id for group folders, otherwise the owner id. */
export interface FolderPageKey { kind: FolderKind; spaceId: string; id: string }

/**
 * Paged list for MCP `list_folders`. Same visibility predicate and the same mismatch-throws rule as `listVisibleFolders`.
 * Keyset order is (kind, space id, id); `limit + 1` rows are fetched to compute `hasMore`. Each row carries the root-to-leaf
 * `path` (the outer column is spelled `"folders"."id"` with the table name, see `NOTES_FOLDER_ID` in `sql.ts`) and `groupName`.
 */
export async function listVisibleFoldersPage(
  db: DbOrTx,
  userId: string,
  opts: { limit: number; after: FolderPageKey | null; groupId?: string; ids?: readonly string[] },
): Promise<{ rows: Array<{ access: FolderAccess; path: string[]; groupName: string | null; key: FolderPageKey }>; hasMore: boolean }> {
  const spaceId = sql`coalesce(${folders.groupId}, ${folders.ownerId})`;
  const keyset =
    opts.after === null
      ? undefined
      : sql`(${folders.kind}, ${spaceId}, ${folders.id}) > (${opts.after.kind}::text, ${opts.after.spaceId}::uuid, ${opts.after.id}::uuid)`;
  const rows = await db
    .select({
      ...accessColumns(),
      groupName: groups.name,
      path: folderPathJsonSql(sql.raw('"folders"."id"')),
    })
    .from(folders)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, folders.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .leftJoin(groups, eq(groups.id, folders.groupId))
    .where(
      and(
        visibleFolderWhere(userId),
        keyset,
        opts.groupId === undefined ? undefined : eq(folders.groupId, opts.groupId),
        opts.ids === undefined ? undefined : inArray(folders.id, [...opts.ids]),
      ),
    )
    .orderBy(asc(folders.kind), spaceId, asc(folders.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit).map(row => ({ row, access: folderAccessFromRow(row, userId) }));
  const hidden = page.filter(p => p.access === null).length;
  // The message omits folder ids; the error log keeps only the count.
  if (hidden > 0) throw new Error(`listVisibleFoldersPage: SQL 篩選與 folderAccessOf 不一致（${hidden} 列）`);
  return {
    rows: page.map(({ row, access }) => ({
      access: access!,
      path: row.path ?? [],
      groupName: row.groupName,
      key: { kind: access!.space.kind, spaceId: (row.folder.groupId ?? row.folder.ownerId)!, id: row.folder.id },
    })),
    hasMore: rows.length > opts.limit,
  };
}
