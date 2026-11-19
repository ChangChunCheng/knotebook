import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { LAST_SITE_ADMIN_MESSAGE } from "./admin-demote.js";
import { revokePendingPasswordResetsInTx } from "./password-reset.js";
import { deleteUserSessionsInTx } from "./sessions.js";

/**
  * tv is bumped in SQL, conditioned on `disabled_at IS NULL`, so a repeat call hits 0 rows without a second bump; only `id` is returned
  * so `passwordHash`/`tokenVersion` never enter memory. First lock all enabled admin rows `FOR NO KEY UPDATE` in id order (a subset
  * of demote's locks, same order); the sole admin gets 409 `last_site_admin` (same code and message as demote). Not `FOR UPDATE`: it
  * would block the FK's `KEY SHARE` and cycle with the link transaction (40P01); concurrent mutual disables queue on the lock and the
  * later one no longer matches `disabled_at IS NULL`. Lock order: admin rows, the target row, link rows, then session rows (same as
  * reset). Links are revoked only on a hit so they don't revive on re-enable; session rows are all deleted (old JWTs are already
  * rejected by tv, deleting rows keeps "all revoked" from depending on tv alone) and re-enabling brings back no session.
  */
export async function disableUserInTx(
  tx: Tx,
  input: { id: string },
): Promise<{ disabled: false } | { disabled: true; revokedResetLinks: number }> {
  const enabledAdmins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .for("no key update");
  if (enabledAdmins.length === 1 && enabledAdmins[0]!.id === input.id) {
    throw new TxAbort(409, "last_site_admin", LAST_SITE_ADMIN_MESSAGE);
  }
  const [updated] = await tx
    .update(users)
    .set({ disabledAt: sql`now()`, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, input.id), isNull(users.disabledAt)))
    .returning({ id: users.id });
  if (!updated) return { disabled: false };
  const revokedResetLinks = await revokePendingPasswordResetsInTx(tx, input.id);
  await deleteUserSessionsInTx(tx, input.id);
  return { disabled: true, revokedResetLinks };
}
