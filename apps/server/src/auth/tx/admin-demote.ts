import { asc, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import type { AdminTestHook } from "../admin-test-hook.js";

export const LAST_SITE_ADMIN_MESSAGE = "The site needs at least one active admin.";

/**
  * Self-demote is rejected by the route (400) before the transaction. All admin rows are locked `FOR NO KEY UPDATE` in id order (not
  * `FOR UPDATE`: that would block the FK's `KEY SHARE` and cycle with the reset-link transaction). A concurrent demote queues, then
  * PostgreSQL re-evaluates `WHERE is_admin` on the changed row and the later one counts 0, giving 409. `disable-user.ts` takes a
  * subset of these locks in the same order.
  */
export async function demoteSiteAdminInTx(tx: Tx, input: { targetId: string }, hook?: AdminTestHook): Promise<void> {
  const admins = await tx
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .for("no key update");
  if (!admins.some(a => a.id === input.targetId)) {
    const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.targetId)).limit(1);
    if (exists === undefined) throw new TxAbort(404, "user_not_found", "No user with that id.");
    return;
  }
  const othersEnabled = admins.filter(a => a.id !== input.targetId && a.disabledAt === null).length;
  await hook?.("demote-locked", { targetId: input.targetId });
  if (othersEnabled === 0) throw new TxAbort(409, "last_site_admin", LAST_SITE_ADMIN_MESSAGE);
  await tx.update(users).set({ isAdmin: false }).where(eq(users.id, input.targetId));
}
