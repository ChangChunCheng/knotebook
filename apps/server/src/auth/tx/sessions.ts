import { eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { sessions } from "../../db/schema.js";

// Lock order: the caller has already touched the `users` row; session rows come last.

/** `expires_at = now + ttlSeconds` (not sliding). `ttlSeconds` must equal the JWT exp and cookie maxAge of the same issuance. The non-transactional `insertSession` uses this too. */
export function newSessionValues(userId: string, ttlSeconds: number): { userId: string; expiresAt: Date } {
  return { userId, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

export async function replaceUserSessionsInTx(tx: Tx, userId: string, ttlSeconds: number): Promise<string> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  const [row] = await tx.insert(sessions).values(newSessionValues(userId, ttlSeconds)).returning({ id: sessions.id });
  return row!.id;
}

export async function deleteUserSessionsInTx(tx: Tx, userId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}
