import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { replaceUserSessionsInTx } from "./sessions.js";

/**
  * Bump tv and replace session rows in ONE transaction: the user-row lock is held to commit, so concurrent changes serialize and the
  * later writer stays signed in. Split, "A-bump, B-bump, B-replace, A-replace" would delete B's fresh row while A's JWT carries a stale
  * tv. Lock order: user row, then session rows (same as reset and disable). tv is +1 in SQL and the DB value is returned.
  */
export async function changePasswordInTx(tx: Tx, input: { userId: string; passwordHash: string; ttlSeconds: number }): Promise<{ tokenVersion: number; sessionId: string } | null> {
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1`, mustChangePassword: false })
    .where(eq(users.id, input.userId))
    .returning({ tokenVersion: users.tokenVersion });
  if (!updated) return null;
  return { tokenVersion: updated.tokenVersion, sessionId: await replaceUserSessionsInTx(tx, input.userId, input.ttlSeconds) };
}

export async function setPasswordInTx(tx: Tx, input: { userId: string; passwordHash: string; ttlSeconds: number }): Promise<{ tokenVersion: number; sessionId: string } | null> {
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, input.userId), isNull(users.passwordHash)))
    .returning({ tokenVersion: users.tokenVersion });
  if (!updated) return null;
  return { tokenVersion: updated.tokenVersion, sessionId: await replaceUserSessionsInTx(tx, input.userId, input.ttlSeconds) };
}
