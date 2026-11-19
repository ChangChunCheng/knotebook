/**
 * Locks and in-transaction reads for folder transactions. Takes only `tx`, plain data and the test hook.
 * Global lock order: (1) groups row locks → (2) structure locks (by key string) → (3) folder rows (by id) → (4) note rows → (5) quota advisory lock. Callers acquire in this order.
 * Each structure lock takes three statements, like `storage/tx/quota.ts`: `set_config('lock_timeout', …, true)` → `pg_advisory_xact_lock`
 * (alone; waiting too long gives 55P03, which routes map to 409 server_busy) → `set local lock_timeout to default`.
 * Keys use the prefix `knotebook.folders:`, separate from the quota lock's `knotebook.storage:`.
 * Transactions that take structure locks must be READ COMMITTED: the statement after the lock takes a fresh snapshot that sees folders
 * committed by the previous holder. Under REPEATABLE READ the snapshot is fixed at the first statement, so depth/cycle/name checks would read a stale tree.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders, groupMembers, groupRoles, groups } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import type { FolderRoleFlags } from "../permissions.js";
import { folderAccessOf, type FolderAccess, type FolderRow } from "../queries.js";
import { folderSpaceOfRow, sortedSpaceLockKeys, type FolderSpace } from "../space.js";

export async function lockGroupsKeyShareInTx(tx: Tx, groupIds: readonly string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const rows = await tx.select({ id: groups.id }).from(groups).where(inArray(groups.id, [...groupIds])).orderBy(asc(groups.id)).for("key share");
  return new Set(rows.map(r => r.id));
}

export interface FolderSpaceLockOpts {
  /** Max wait per key (ms), a positive integer; the caller passes `storageLockTimeoutMs`. */
  lockTimeoutMs: number;
  /** Test hook (never injected in production): fired once with `"folder-structure-locked"` after all keys are taken. */
  hook?: GroupTestHook;
  hookCtx?: GroupHookCtx;
}

/** Takes structure locks one by one in `sortedSpaceLockKeys` order, then fires the hook once. */
export async function lockFolderSpacesInTx(tx: Tx, spaces: readonly FolderSpace[], opts: FolderSpaceLockOpts): Promise<void> {
  const keys = sortedSpaceLockKeys(spaces);
  if (keys.length === 0) return;
  if (!Number.isInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs <= 0) {
    throw new Error(`lockFolderSpacesInTx: lockTimeoutMs 必須是正整數（收到 ${opts.lockTimeoutMs}）`);
  }
  for (const key of keys) {
    await tx.execute(sql`select set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}::text, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
    await tx.execute(sql`set local lock_timeout to default`);
  }
  await opts.hook?.("folder-structure-locked", opts.hookCtx ?? {});
}

/** Single-table on purpose: a row lock can't be added to a LEFT JOIN statement. */
export async function lockFolderInTx(tx: Tx, folderId: string, strength: "key share" | "update"): Promise<FolderRow | undefined> {
  const [row] = await tx.select().from(folders).where(eq(folders.id, folderId)).for(strength);
  return row;
}

/** Group role flags, read without locking: callers already hold groups KEY SHARE, so membership is stable. Non-member → null. */
export async function memberFlagsInTx(tx: Tx, userId: string, groupId: string): Promise<FolderRoleFlags | null> {
  const [row] = await tx
    .select({ canRead: groupRoles.canRead, canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit, canDelete: groupRoles.canDelete })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** In-transaction visibility and permissions (same derivation as `folderAccessFromRow`: `folderAccessOf`). Not visible → null. */
export async function folderAccessInTx(tx: Tx, userId: string, folder: FolderRow): Promise<FolderAccess | null> {
  const space = folderSpaceOfRow(folder);
  const flags = space.kind === "group" ? await memberFlagsInTx(tx, userId, space.groupId) : null;
  return folderAccessOf(folder, flags, userId);
}
