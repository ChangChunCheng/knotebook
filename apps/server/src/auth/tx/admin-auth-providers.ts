import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { authProviders } from "../../db/schema.js";
import type { EncryptedSecret } from "../../lib/sealed-secret.js";
import { TxAbort } from "../../http/tx-abort.js";
import { assertSsoOnlyGuardInTx, lockSiteSettingsInTx } from "./admin-site-settings.js";

// `hasSecret` is computed in SQL; the ciphertext is never SELECTed.

export interface AdminProviderRow {
  id: string;
  template: string;
  displayName: string;
  issuerUrl: string;
  clientId: string | null;
  enabled: boolean;
  autoCreateEnabled: boolean;
  sortOrder: number;
  legacyCallback: boolean;
  configVersion: number;
  createdAt: Date;
  hasSecret: boolean;
  issuerResolved: boolean;
  iconKind: string;
  iconVersion: number;
}

/** `createdAt` must be the column itself: a raw `sql` timestamp comes back as a string. */
export function adminProviderColumns() {
  return {
    id: authProviders.id,
    template: authProviders.template,
    displayName: authProviders.displayName,
    issuerUrl: authProviders.issuerUrl,
    clientId: authProviders.clientId,
    enabled: authProviders.enabled,
    autoCreateEnabled: authProviders.autoCreateEnabled,
    sortOrder: authProviders.sortOrder,
    legacyCallback: authProviders.legacyCallback,
    configVersion: authProviders.configVersion,
    createdAt: authProviders.createdAt,
    hasSecret: sql<boolean>`${authProviders.clientSecretEncrypted} is not null`,
    issuerResolved: sql<boolean>`${authProviders.resolvedIssuer} is not null`,
    iconKind: authProviders.iconKind,
    iconVersion: authProviders.iconVersion,
  };
}

export interface UpdateAuthProviderInput {
  id: string;
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  sortOrder?: number;
  enabled?: boolean;
  autoCreateEnabled?: boolean;
  /** Setting it clears the uploaded image (data/mime NULL) in the same UPDATE; `icon_version` and `config_version` are untouched. */
  iconKind?: "template" | "gitlab" | "google" | "none";
  actorUserId: string;
  /** Sealed outside the transaction (AAD bound to the id); undefined means no new secret. */
  newSecretSealed?: EncryptedSecret;
}

export interface UpdateAuthProviderResult {
  row: AdminProviderRow;
    /** Audit log only: a plain read after the site-settings lock, so every issuer change queues behind it (`recordResolvedIssuer` doesn't take that lock but writes only `resolved_issuer`). */
  previousIssuerUrl: string;
  /** Audit log only, same as `previousIssuerUrl`. */
  previousAutoCreateEnabled: boolean;
}

/**
  * Every "did it change" decision sits on the right side of this one UPDATE's SET: it sees the old tuple under the row
  * lock, whereas read-then-compare in Node is a TOCTOU. Omitted fields coalesce to the current value. An issuer change
  * clears `resolved_issuer` and force-disables (without a secret it also clears the secret); the version bumps when a
  * secret is set or issuer/client id actually changed. `autoCreateEnabled` affects neither the version nor the guard.
  */
export async function updateAuthProviderInTx(tx: Tx, input: UpdateAuthProviderInput): Promise<UpdateAuthProviderResult> {
  // Site-settings lock first (serializes all site-settings writes), so the `before` read below can be trusted.
  const settings = await lockSiteSettingsInTx(tx);
  const [before] = await tx
    .select({ issuerUrl: authProviders.issuerUrl, enabled: authProviders.enabled, autoCreateEnabled: authProviders.autoCreateEnabled })
    .from(authProviders)
    .where(eq(authProviders.id, input.id))
    .limit(1);
  if (!before) throw new TxAbort(404, "not_found", "No sign-in service with that id.");

  const newIssuer = () => sql`coalesce(${input.issuerUrl ?? null}::text, ${authProviders.issuerUrl})`;
  const newClientId = () => sql`coalesce(${input.clientId ?? null}::text, ${authProviders.clientId})`;
  const issuerChanged = () => sql`${authProviders.issuerUrl} is distinct from ${newIssuer()}`;
  const clientChanged = () => sql`${authProviders.clientId} is distinct from ${newClientId()}`;

  const common = {
    issuerUrl: newIssuer(),
    clientId: newClientId(),
    displayName: sql`coalesce(${input.displayName ?? null}::text, ${authProviders.displayName})`,
    sortOrder: sql`coalesce(${input.sortOrder ?? null}::integer, ${authProviders.sortOrder})`,
    resolvedIssuer: sql`case when ${issuerChanged()} then null else ${authProviders.resolvedIssuer} end`,
    enabled: sql`case when ${issuerChanged()} then false else coalesce(${input.enabled ?? null}::boolean, ${authProviders.enabled}) end`,
    // Not forced on an issuer change (the UI's confirmation decides) and not part of the version decision.
    autoCreateEnabled: sql`coalesce(${input.autoCreateEnabled ?? null}::boolean, ${authProviders.autoCreateEnabled})`,
    // Without `iconKind` all three columns keep their value; with it the kind changes and the image is cleared (CHECK `auth_providers_icon_upload_chk`: non-upload means data and mime are both NULL).
    iconKind: sql`coalesce(${input.iconKind ?? null}::text, ${authProviders.iconKind})`,
    iconData: sql`case when ${input.iconKind ?? null}::text is null then ${authProviders.iconData} else null::bytea end`,
    iconMime: sql`case when ${input.iconKind ?? null}::text is null then ${authProviders.iconMime} else null::text end`,
    updatedAt: sql`now()`,
  };
  const set =
    input.newSecretSealed === undefined
      ? {
          ...common,
          clientSecretEncrypted: sql`case when ${issuerChanged()} then null::jsonb else ${authProviders.clientSecretEncrypted} end`,
          configVersion: sql`case when ${issuerChanged()} or ${clientChanged()} then ${authProviders.configVersion} + 1 else ${authProviders.configVersion} end`,
        }
      : {
          ...common,
          clientSecretEncrypted: input.newSecretSealed,
          configVersion: sql`${authProviders.configVersion} + 1`,
        };

  const [row] = await tx.update(authProviders).set(set).where(eq(authProviders.id, input.id)).returning(adminProviderColumns());
  if (!row) throw new TxAbort(404, "not_found", "No sign-in service with that id.");
  // Lock-out guard on the post-write state when password login is off and an enabled true->false change (incl. the implicit disable on an issuer change) happened.
  if (!settings.passwordLoginEnabled && before.enabled && !row.enabled) await assertSsoOnlyGuardInTx(tx, input.actorUserId);
  return { row, previousIssuerUrl: before.issuerUrl, previousAutoCreateEnabled: before.autoCreateEnabled };
}

/** One statement deletes only if disabled (serialized with a concurrent enable by the row lock); on 0 rows it re-queries to tell 409 from 404. Identities are untouched, so recreating with the same issuer restores them. No lock-out guard: only a disabled provider can be deleted. */
export async function deleteAuthProviderInTx(tx: Tx, input: { id: string }): Promise<void> {
  await lockSiteSettingsInTx(tx);
  const deleted = await tx
    .delete(authProviders)
    .where(and(eq(authProviders.id, input.id), eq(authProviders.enabled, false)))
    .returning({ id: authProviders.id });
  if (deleted.length === 1) return;
  const [still] = await tx.select({ enabled: authProviders.enabled }).from(authProviders).where(eq(authProviders.id, input.id)).limit(1);
  if (still) throw new TxAbort(409, "provider_enabled", "This sign-in service is still enabled. Disable it before deleting it.");
  throw new TxAbort(404, "not_found", "No sign-in service with that id.");
}
