import { and, asc, eq, sql } from "drizzle-orm";
import type * as client from "openid-client";
import type { AdminAuthProbeWarning, AuthProviderPublicDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders, userIdentities } from "../db/schema.js";
import { openSecret, sealSecret, type EncryptedSecret } from "../lib/sealed-secret.js";
import type { OidcRuntimeRegistry } from "./oidc-client.js";
import { providerIconColumns, toPublicProvider } from "./provider-icon.js";

// Every identity<->provider match uses the effective issuer `coalesce(resolved_issuer, issuer_url)`, never `issuer_url =`.

export const OIDC_CLIENT_SECRET_NAMESPACE = "oidc-client-secret";

export function clientSecretAad(providerId: string): string {
  return `oidc-client-secret:v1:${providerId}`;
}

export function sealClientSecret(appSecret: string, providerId: string, plaintext: string): EncryptedSecret {
  return sealSecret(appSecret, OIDC_CLIENT_SECRET_NAMESPACE, plaintext, clientSecretAad(providerId));
}

export function openClientSecret(appSecret: string, provider: { id: string; clientSecretEncrypted: unknown }): string {
  return openSecret(appSecret, OIDC_CLIENT_SECRET_NAMESPACE, provider.clientSecretEncrypted, clientSecretAad(provider.id));
}

export interface OidcProviderRow {
  id: string;
  displayName: string;
  issuerUrl: string;
  resolvedIssuer: string | null;
  clientId: string;
  clientSecretEncrypted: EncryptedSecret | null;
  enabled: boolean;
  legacyCallback: boolean;
  configVersion: number;
}

function providerColumns() {
  return {
    id: authProviders.id,
    displayName: authProviders.displayName,
    issuerUrl: authProviders.issuerUrl,
    resolvedIssuer: authProviders.resolvedIssuer,
    clientId: authProviders.clientId,
    clientSecretEncrypted: authProviders.clientSecretEncrypted,
    enabled: authProviders.enabled,
    legacyCallback: authProviders.legacyCallback,
    configVersion: authProviders.configVersion,
  };
}

/** A NULL client_id counts as no usable provider (unreachable: CHECK `auth_providers_enabled_client_id_chk`, and both read paths read enabled rows only). */
function withClientId(row: (Omit<OidcProviderRow, "clientId"> & { clientId: string | null }) | undefined): OidcProviderRow | null {
  if (row === undefined) return null;
  const { clientId } = row;
  if (clientId === null) return null;
  return { ...row, clientId };
}

/** `id` must already match UUID_RE and be lowercased by the caller. */
export async function loadEnabledProvider(db: DbOrTx, id: string): Promise<OidcProviderRow | null> {
  const [row] = await db.select(providerColumns()).from(authProviders).where(and(eq(authProviders.id, id), eq(authProviders.enabled, true))).limit(1);
  return withClientId(row);
}

export async function loadLegacyProvider(db: DbOrTx): Promise<OidcProviderRow | null> {
  const [row] = await db
    .select(providerColumns())
    .from(authProviders)
    .where(and(eq(authProviders.legacyCallback, true), eq(authProviders.enabled, true)))
    .limit(1);
  return withClientId(row);
}

export async function listEnabledProvidersForConfig(
  db: DbOrTx,
): Promise<{ providers: AuthProviderPublicDto[]; autoCreateProviderIds: string[] }> {
  const rows = await db
    .select({ id: authProviders.id, displayName: authProviders.displayName, ...providerIconColumns(), autoCreateEnabled: authProviders.autoCreateEnabled })
    .from(authProviders)
    .where(eq(authProviders.enabled, true))
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
  return { providers: rows.map(toPublicProvider), autoCreateProviderIds: rows.filter(r => r.autoCreateEnabled).map(r => r.id) };
}

/** Takes `DbOrTx`: inside the decision transaction pass the tx, never the pool. Lists shown to users must go through `excludeSameIssuerProviders` (`auth/issuer.ts`): the raw list leaks "this account already linked that IdP" before proof. */
export async function linkedEnabledProvidersWithIssuer(
  q: DbOrTx,
  userId: string,
): Promise<Array<AuthProviderPublicDto & { effectiveIssuer: string }>> {
  const rows = await q
    .select({
      id: authProviders.id,
      displayName: authProviders.displayName,
      ...providerIconColumns(),
      effectiveIssuer: sql<string>`coalesce(${authProviders.resolvedIssuer}, ${authProviders.issuerUrl})`,
    })
    .from(authProviders)
    .where(
      and(
        eq(authProviders.enabled, true),
        sql`exists (select 1 from ${userIdentities} where ${userIdentities.userId} = ${userId} and ${userIdentities.issuer} = coalesce(${authProviders.resolvedIssuer}, ${authProviders.issuerUrl}))`,
      ),
    )
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
  return rows.map(r => ({ ...toPublicProvider(r), effectiveIssuer: r.effectiveIssuer }));
}

/** Version predicate: a stale discovery result must not overwrite newer config (an issuer change clears `resolved_issuer` and bumps the version). Equal values aren't written (`IS DISTINCT FROM`). Never inside a transaction. Returns whether a row was written. */
export async function recordResolvedIssuer(db: Db, provider: { id: string; configVersion: number }, issuer: string): Promise<boolean> {
  const rows = await db
    .update(authProviders)
    .set({ resolvedIssuer: issuer })
    .where(
      and(
        eq(authProviders.id, provider.id),
        eq(authProviders.configVersion, provider.configVersion),
        sql`${authProviders.resolvedIssuer} is distinct from ${issuer}`,
      ),
    )
    .returning({ id: authProviders.id });
  return rows.length === 1;
}

/** The registry doesn't touch the DB, so the `resolved_issuer` write-back is here. Best-effort: a DB failure is warned (provider id and error message only) and swallowed, since this login takes the issuer from the discovery result itself; the next discovery retries. Only the registry lookup can throw (`OidcUnavailableError`). */
export async function providerConfiguration(
  deps: { db: Db; registry: OidcRuntimeRegistry; appSecret: string; log?: { warn(obj: object, msg: string): void } },
  provider: OidcProviderRow,
): Promise<client.Configuration> {
  const configuration = await deps.registry.get(
    { id: provider.id, issuerUrl: provider.issuerUrl, clientId: provider.clientId, configVersion: provider.configVersion },
    async () => openClientSecret(deps.appSecret, provider),
  );
  const issuer = configuration.serverMetadata().issuer;
  if (provider.resolvedIssuer !== issuer) {
    try {
      await recordResolvedIssuer(deps.db, provider, issuer);
    } catch (err) {
      deps.log?.warn(
        { providerId: provider.id, error: err instanceof Error ? err.message : String(err) },
        "resolved_issuer 寫回失敗（盡力而為，登入照常）",
      );
    }
  }
  return configuration;
}

/** An absent `token_endpoint_auth_methods_supported` counts as not advertising `client_secret_post` (RFC 8414 defaults to `client_secret_basic`), which is what Knotebook always uses. */
export function probeWarnings(issuerUrl: string, metadata: { token_endpoint_auth_methods_supported?: string[] }): AdminAuthProbeWarning[] {
  const warnings: AdminAuthProbeWarning[] = [];
  if (issuerUrl.startsWith("http://")) warnings.push("insecure_issuer");
  if (!(metadata.token_endpoint_auth_methods_supported ?? []).includes("client_secret_post")) warnings.push("client_secret_post_not_advertised");
  return warnings;
}
