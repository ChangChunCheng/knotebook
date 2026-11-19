/**
 * The only place a quota is decided; called after the transaction's row locks and before any write in the space's scope (keeps lock
 * order acyclic). Each step is its own statement: `incoming <= 0` returns without locking (only additions are blocked); `lock_timeout`
 * is set via `set_config` (`SET` takes no bind parameters), the advisory lock is alone (55P03 maps to 409 server_busy), then
 * `lock_timeout` goes back TO DEFAULT (not 0: that restores the role/database/config value, so only the space-lock statement is bounded).
 * The SUM must be a separate statement after the lock: READ COMMITTED snapshots per statement, which is what sees the previous holder's
 * commit (the advisory xact lock is released only once the commit is visible). A NULL quota means unlimited; used + incoming equal to the
 * quota passes. Callers must run READ COMMITTED.
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groups, notes, storagePlans, uploads, users } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { STORAGE_QUOTA_EXCEEDED_MESSAGE, spaceLockKey, spaceNotesWhere, sumAvatarBytesSql, sumUploadSizeSql, type StorageSpace } from "../space.js";

export const DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 5000;

export interface SpaceRoomOpts {
  lockTimeoutMs: number;
  hook?: GroupTestHook;
  hookCtx?: { noteId?: string; groupId?: string };
}

/** Extends `TxAbort` so an unhandled one still maps to the right code; carries `space` and the numbers so the route decides visibility outside the transaction. */
export class StorageQuotaExceeded extends TxAbort {
  constructor(
    readonly space: StorageSpace,
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly incomingBytes: number,
  ) {
    super(409, "storage_quota_exceeded", STORAGE_QUOTA_EXCEEDED_MESSAGE);
    this.name = "StorageQuotaExceeded";
  }
}

export async function assertSpaceRoomInTx(tx: Tx, space: StorageSpace, incomingBytes: number, opts: SpaceRoomOpts): Promise<void> {
  if (!(incomingBytes > 0)) return;
  if (!Number.isInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs <= 0) {
    throw new Error(`assertSpaceRoomInTx: lockTimeoutMs 必須是正整數（收到 ${opts.lockTimeoutMs}）`);
  }
  await tx.execute(sql`select set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}::text, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${spaceLockKey(space)}::text, 0))`);
  await tx.execute(sql`set local lock_timeout to default`);
  await opts.hook?.("storage-space-locked", opts.hookCtx ?? {});

  const [plan] = space.kind === "user"
    ? await tx.select({ quotaBytes: storagePlans.quotaBytes }).from(users).innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId)).where(eq(users.id, space.id))
    : await tx.select({ quotaBytes: storagePlans.quotaBytes }).from(groups).innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId)).where(eq(groups.id, space.id));
  if (!plan) throw new Error(`assertSpaceRoomInTx: 找不到空間 ${space.kind}:${space.id}`);
  if (plan.quotaBytes === null) return;

  const avatar = space.kind === "user" ? sumAvatarBytesSql(space.id) : sql<number>`0`.mapWith(Number);
  const [row] = await tx.select({ used: sumUploadSizeSql(), avatar }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).where(spaceNotesWhere(space));
  const usedBytes = (row?.used ?? 0) + (row?.avatar ?? 0);
  if (usedBytes + incomingBytes > plan.quotaBytes) {
    throw new StorageQuotaExceeded(space, usedBytes, plan.quotaBytes, incomingBytes);
  }
}
