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
  flags: FolderRoleFlags | null;
  permissions: FolderPermissionsDto;
}

/** The single derivation of visibility and permissions; invisible looks the same as nonexistent (null). */
export function folderAccessOf(folder: FolderRow, flags: FolderRoleFlags | null, userId: string): FolderAccess | null {
  const space = folderSpaceOfRow(folder);
  const permissions = folderPermissions(space, userId, flags);
  return permissions === null ? null : { folder, space, flags, permissions };
}

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

/** Needs the same LEFT JOINs as `folderAccessQuery`. */
function visibleFolderWhere(userId: string): SQL {
  return or(eq(folders.ownerId, userId), and(isNotNull(groupMembers.userId), eq(groupRoles.canRead, true)))!;
}

/** Throws instead of hiding a row: a SQL/`folderAccessOf` mismatch is a bug, and failing beats leaking or silently dropping a folder. */
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
  // No folder ids in the message; the error log keeps only the count.
  if (hidden > 0) throw new Error(`listVisibleFolders: SQL 篩選與 folderAccessOf 不一致（${hidden} 列）`);
  return accesses.map(a => toFolderDto(a!.folder, a!.permissions));
}

export type FolderKind = FolderSpace["kind"];
export const FOLDER_KINDS: readonly FolderKind[] = ["group", "personal", "shared"];
export interface FolderPageKey { kind: FolderKind; spaceId: string; id: string }

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
      // Table-qualified literal so the correlated CTE can't bind the inner alias.
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
  // No folder ids in the message; the error log keeps only the count.
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
