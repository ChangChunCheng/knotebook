import { asc, eq, sql, type SQL } from "drizzle-orm";
import { resolveProviderIcon, type AdminAuthSettingsDto, type ProviderIconDto } from "@knotebook/shared";
import { providerIconColumns } from "./provider-icon.js";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders } from "../db/schema.js";

// Matching is exact on the effective issuer (the loose `issuerKey` is only for exclusion). A password counts by its DB value,
// not env, so a state reached during env rescue still holds after env is removed.

export interface EnabledProviderIssuer {
  id: string;
  displayName: string;
  template: string;
  effectiveIssuer: string;
  icon: ProviderIconDto;
}

export async function enabledProvidersWithIssuer(q: DbOrTx): Promise<EnabledProviderIssuer[]> {
  const rows = await q
    .select({
      id: authProviders.id,
      displayName: authProviders.displayName,
      ...providerIconColumns(),
      effectiveIssuer: sql<string>`coalesce(${authProviders.resolvedIssuer}, ${authProviders.issuerUrl})`,
    })
    .from(authProviders)
    .where(eq(authProviders.enabled, true))
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
  return rows.map(r => ({ id: r.id, displayName: r.displayName, template: r.template, effectiveIssuer: r.effectiveIssuer, icon: resolveProviderIcon(r) }));
}

export function usableIdentityIds(
  identities: ReadonlyArray<{ id: string; issuer: string }>,
  enabled: ReadonlyArray<{ effectiveIssuer: string }>,
): Set<string> {
  const issuers = new Set(enabled.map(p => p.effectiveIssuer));
  return new Set(identities.filter(i => issuers.has(i.issuer)).map(i => i.id));
}

export function canUnlinkIdentity(
  identityId: string,
  s: { hasPassword: boolean; passwordLoginDbValue: boolean; usableIdentityIds: ReadonlySet<string> },
): boolean {
  if (s.hasPassword && s.passwordLoginDbValue) return true;
  for (const id of s.usableIdentityIds) if (id !== identityId) return true;
  return false;
}

/**
 * Also inlined in `passwordLoginImpact` and `auth/provider-impact.ts` (bind parameters can't express a correlated
 * subquery over each outer row): change all three together. `exceptProviderId` excludes by provider, not issuer.
 */
export function usableSsoExists(userId: string, exceptProviderId?: string): SQL {
  const except = exceptProviderId === undefined ? sql`` : sql` and p.id <> ${exceptProviderId}`;
  return sql`exists (
      select 1 from user_identities i
      join auth_providers p on i.issuer = coalesce(p.resolved_issuer, p.issuer_url)
      where i.user_id = ${userId} and p.enabled${except}
    )`;
}

export async function hasUsableSso(q: DbOrTx, userId: string): Promise<boolean> {
  const result = await q.execute<{ ok: boolean }>(sql`select ${usableSsoExists(userId)} as ok`);
  return result.rows[0]!.ok;
}

export async function passwordLoginImpact(db: Db, actorUserId: string): Promise<AdminAuthSettingsDto["passwordLoginImpact"]> {
  const result = await db.execute<{ without_sso: number; enabled: number }>(sql`
    select
      (select count(*)::int from users u
        where u.disabled_at is null
          and not exists (
            select 1 from user_identities i
            join auth_providers p on i.issuer = coalesce(p.resolved_issuer, p.issuer_url)
            where i.user_id = u.id and p.enabled
          )) as without_sso,
      (select count(*)::int from auth_providers where enabled) as enabled`);
  const row = result.rows[0]!;
  return { usersWithoutSso: row.without_sso, actingAdminHasSso: await hasUsableSso(db, actorUserId), enabledProviders: row.enabled };
}
