import { sql } from "drizzle-orm";
import type { AdminAuthProviderImpactDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { usableSsoExists } from "./sign-in-methods.js";

/**
  * Snapshot. Matching is exact on the effective issuer, so with `resolved_issuer` NULL it may miss (trailing-slash forms);
  * `issuerResolved` lets the page say the count may be off. "No password" means `password_hash IS NULL` or the password-login
  * DB value is off (same as unlink; env ignored). Locked-out counts are per provider, not per identity: two providers sharing an
  * issuer still let the same identity sign in through the other. `actingAdminLockedOut` uses `usableSsoExists` (the lock-out
  * guard's predicate) and counts whether or not this provider is enabled now (consistent with linkedUsers).
  */
export async function providerImpact(db: Db, providerId: string, actorUserId: string): Promise<AdminAuthProviderImpactDto | null> {
  const result = await db.execute<{ linked: number; locked: number; resolved: boolean | null; acting_locked_out: boolean }>(sql`
    with s as (
      select coalesce((select password_login_enabled from site_settings where singleton), true) as pw
    ),
    p as (
      select coalesce(resolved_issuer, issuer_url) as eff, resolved_issuer is not null as resolved
      from auth_providers where id = ${providerId}
    ),
    linked as (
      select distinct u.id, u.password_hash
      from p
      join user_identities i on i.issuer = p.eff
      join users u on u.id = i.user_id
      where u.disabled_at is null
    )
    select
      (select count(*)::int from linked) as linked,
      (select count(*)::int from linked l
         where (l.password_hash is null or not (select pw from s))
           and not exists (
             select 1 from user_identities i2
             join auth_providers p2 on i2.issuer = coalesce(p2.resolved_issuer, p2.issuer_url)
             where i2.user_id = l.id and p2.enabled and p2.id <> ${providerId}
           )) as locked,
      (select resolved from p) as resolved,
      (exists (select 1 from p join user_identities i on i.issuer = p.eff where i.user_id = ${actorUserId})
        and not ${usableSsoExists(actorUserId, providerId)}) as acting_locked_out
  `);
  const row = result.rows[0];
  if (!row || row.resolved === null) return null;
  return { linkedUsers: row.linked, lockedOutUsers: row.locked, issuerResolved: row.resolved, actingAdminLockedOut: row.acting_locked_out };
}
