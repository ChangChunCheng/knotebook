import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { oneTimeLinks } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { activeOneTimeLink } from "../one-time-link.js";
import { insertPasswordUserInTx, type PasswordUserInput, type RegisteredUser } from "./register.js";

export const INVITE_INVALID_MESSAGE = "This invite is invalid, already used, revoked or expired.";

/**
 * Lock order: invite row first, then inserts of new `handles`/`users` rows (no existing `users` row is locked). Disable and reset go `users` row
 * then reset row and never touch invite rows; revoke is a single UPDATE and cleanup is SKIP LOCKED, so no path locks something else and then
 * waits for an invite row. Invites deliberately ignore `registration_enabled` (the self-signup switch) and read no `site_settings` inside; the
 * password-login switch is judged outside the transaction.
 */
export async function acceptInviteInTx(tx: Tx, input: { linkId: string } & PasswordUserInput): Promise<RegisteredUser> {
  const [link] = await tx
    .select({ id: oneTimeLinks.id })
    .from(oneTimeLinks)
    .where(and(eq(oneTimeLinks.id, input.linkId), activeOneTimeLink("invite")))
    .for("update");
  if (!link) throw new TxAbort(410, "invite_invalid", INVITE_INVALID_MESSAGE);
  const user = await insertPasswordUserInTx(tx, input);
  await tx.update(oneTimeLinks).set({ usedAt: sql`now()`, usedById: user.id }).where(eq(oneTimeLinks.id, input.linkId));
  return user;
}
