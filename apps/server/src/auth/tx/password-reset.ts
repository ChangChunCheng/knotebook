import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { oneTimeLinks, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { activeOneTimeLink, pendingPasswordResetsOf } from "../one-time-link.js";
import { replaceUserSessionsInTx } from "./sessions.js";

export const RESET_LINK_INVALID_MESSAGE = "This password reset link is invalid, already used or expired.";

// Lock order: `users` row (`FOR NO KEY UPDATE`) first, then the link row; generate, cancel, complete and disable all follow it (no 40P01). NO KEY UPDATE excludes itself and disable's UPDATE but not the FK's `KEY SHARE`.

/** Includes expired rows. The caller must already hold the `users` row lock (lock order). */
export async function revokePendingPasswordResetsInTx(tx: Tx, targetUserId: string): Promise<number> {
  const rows = await tx
    .update(oneTimeLinks)
    .set({ revokedAt: sql`now()` })
    .where(pendingPasswordResetsOf(targetUserId))
    .returning({ id: oneTimeLinks.id });
  return rows.length;
}

async function lockTargetUser(tx: Tx, targetUserId: string): Promise<{ disabledAt: Date | null; hasPassword: boolean }> {
  const [row] = await tx
    .select({ disabledAt: users.disabledAt, hasPassword: sql<boolean>`${users.passwordHash} is not null` })
    .from(users)
    .where(eq(users.id, targetUserId))
    .for("no key update");
  if (!row) throw new TxAbort(404, "user_not_found", "No user with that id.");
  return row;
}

export async function issuePasswordResetInTx(
  tx: Tx,
  input: { targetUserId: string; createdById: string; tokenHash: string; expiresInHours: number },
): Promise<{ linkId: string; expiresAt: Date; replaced: number }> {
  const target = await lockTargetUser(tx, input.targetUserId);
  if (target.disabledAt !== null) throw new TxAbort(409, "user_disabled", "That user's account is disabled.");
  if (!target.hasPassword) throw new TxAbort(409, "password_not_set", "That user has no password to reset.");
  const replaced = await revokePendingPasswordResetsInTx(tx, input.targetUserId);
  const [row] = await tx
    .insert(oneTimeLinks)
    .values({
      kind: "password_reset",
      tokenHash: input.tokenHash,
      targetUserId: input.targetUserId,
      createdById: input.createdById,
      expiresAt: sql`now() + make_interval(hours => ${input.expiresInHours}::int)`,
    })
    .returning({ id: oneTimeLinks.id, expiresAt: oneTimeLinks.expiresAt });
  return { linkId: row!.id, expiresAt: row!.expiresAt, replaced };
}

export async function cancelPasswordResetsInTx(tx: Tx, input: { targetUserId: string }): Promise<{ revoked: number }> {
  await lockTargetUser(tx, input.targetUserId);
  return { revoked: await revokePendingPasswordResetsInTx(tx, input.targetUserId) };
}

/** All rejections are 410 and reachable only under concurrency. Touches only `users` and `one_time_links`: PATs, OAuth and transfer tokens are deliberately left alone. */
export async function completePasswordResetInTx(
  tx: Tx,
  input: { linkId: string; targetUserId: string; passwordHash: string; ttlSeconds: number },
) {
  const [target] = await tx
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .for("no key update");
  if (!target) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  const [link] = await tx
    .select({ targetUserId: oneTimeLinks.targetUserId })
    .from(oneTimeLinks)
    .where(and(eq(oneTimeLinks.id, input.linkId), activeOneTimeLink("password_reset")))
    .for("update");
  if (!link || link.targetUserId !== input.targetUserId) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  if (target.disabledAt !== null) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1`, mustChangePassword: false })
    .where(eq(users.id, input.targetUserId))
    .returning({
      id: users.id,
      email: users.email,
      handle: users.handle,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      autoVersions: users.autoVersions,
      tokenVersion: users.tokenVersion,
    });
  await tx.update(oneTimeLinks).set({ usedAt: sql`now()` }).where(eq(oneTimeLinks.id, input.linkId));
  return { ...updated!, sessionId: await replaceUserSessionsInTx(tx, input.targetUserId, input.ttlSeconds) };
}
