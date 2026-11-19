import { sql } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/index.js";

/**
  * Old code (after a rollback or during a rolling deploy) writes `users.oidc_*` and migration 0014 doesn't rerun, so every
  * boot converges them. Locks no `users` rows. Warns without changing anything when a legacy column points at an identity owned
  * by someone else (this can also leave one account with two subs under one issuer). Unlinking clears the matching legacy
  * columns, so the backfill can't revive an unlinked identity.
  */
export async function backfillLegacyOidcIdentities(db: Db, logger: pino.Logger): Promise<{ inserted: number; conflicts: number }> {
  const inserted = await db.execute(sql`
    insert into user_identities (user_id, issuer, sub)
      select id, oidc_issuer, oidc_sub from users where oidc_issuer is not null and oidc_sub is not null
    on conflict (issuer, sub) do nothing`);
  const conflicts = await db.execute<{ user_id: string; owner_id: string }>(sql`
    select u.id as user_id, i.user_id as owner_id from users u
      join user_identities i on i.issuer = u.oidc_issuer and i.sub = u.oidc_sub
     where i.user_id <> u.id`);
  for (const row of conflicts.rows) {
    logger.warn({ userId: row.user_id, ownerId: row.owner_id }, "legacy users.oidc_issuer/oidc_sub points at an identity that belongs to another account; left unchanged");
  }
  return { inserted: inserted.rowCount ?? 0, conflicts: conflicts.rows.length };
}
