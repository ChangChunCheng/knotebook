/**
 * 資料夾的可見性與清單（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.5、§5.11）。可見性與權限只有一個推導：
 * `folderAccessOf`（交易外的 `folderAccessFromRow` 與交易內的 `folderAccessInTx` 都經它）。看不到與不存在同形（null，AG-F3）。
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import type { FolderDto, FolderPermissionsDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { folders, groupMembers, groupRoles } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { folderPermissions, type FolderRoleFlags } from "./permissions.js";
import { folderSpaceOfRow, toFolderSpaceDto, type FolderSpace } from "./space.js";

export type FolderRow = typeof folders.$inferSelect;

export interface FolderAccess {
  folder: FolderRow;
  space: FolderSpace;
  /** 群組資料夾＝呼叫者的角色旗標（非成員 null）；personal／shared 恆 null。 */
  flags: FolderRoleFlags | null;
  permissions: FolderPermissionsDto;
}

/** 可見性與權限的唯一推導；看不到 → null。 */
export function folderAccessOf(folder: FolderRow, flags: FolderRoleFlags | null, userId: string): FolderAccess | null {
  const space = folderSpaceOfRow(folder);
  const permissions = folderPermissions(space, userId, flags);
  return permissions === null ? null : { folder, space, flags, permissions };
}

/** 資料夾列＋呼叫者在該群組的角色旗標（LEFT JOIN；personal／shared 的 `folders.group_id` 為 NULL，JOIN 必落空）。每次呼叫現造。 */
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

/** `folders LEFT JOIN group_members (group, $u) LEFT JOIN group_roles`；limit 1；不鎖。呼叫前 `folderId` 已過 `UUID_RE`。 */
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

/** 非 UUID → null；看不到 → null（與不存在同形，AG-F3）。 */
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
 * `GET /api/folders`：`owner_id = $u`（personal／shared）∪ 群組成員且 `can_read`。排序：kind、coalesce(group_id, owner_id)、
 * parent_id NULLS FIRST、lower(name)、id。SQL 的篩選與 `folderAccessOf` 不一致（選出了看不到的列）→ throw，不靜默略過：
 * 兩者是同一條可見性規則的兩種寫法，不一致就是 bug——寧可 500，也不把看不到的資料夾送出去、或悄悄少列掩蓋漂移。
 */
export async function listVisibleFolders(db: DbOrTx, userId: string): Promise<FolderDto[]> {
  const rows = await db
    .select(accessColumns())
    .from(folders)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, folders.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(or(eq(folders.ownerId, userId), and(isNotNull(groupMembers.userId), eq(groupRoles.canRead, true))))
    .orderBy(
      asc(folders.kind),
      sql`coalesce(${folders.groupId}, ${folders.ownerId})`,
      sql`${folders.parentId} asc nulls first`,
      sql`lower(${folders.name})`,
      asc(folders.id),
    );
  const accesses = rows.map(row => folderAccessFromRow(row, userId));
  const hidden = accesses.filter(a => a === null).length;
  // 訊息不帶資料夾 id（錯誤 log 只記計數）
  if (hidden > 0) throw new Error(`listVisibleFolders: SQL 篩選與 folderAccessOf 不一致（${hidden} 列）`);
  return accesses.map(a => toFolderDto(a!.folder, a!.permissions));
}
