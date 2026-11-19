import { randomUUID } from "node:crypto";
import { normalizeEmail } from "@knotebook/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { authProviders, handles, siteSettings, userIdentities, users } from "../../db/schema.js";
import { deriveHandle } from "../handle.js";
import { linkedEnabledProvidersWithIssuer } from "../oidc-providers.js";
import type { OidcTestHook } from "../oidc-test-hook.js";
import { decideOidcLogin, type OidcCandidateRow, type OidcClaims, type OidcRejectCode } from "../oidc-login-decision.js";

export type OidcLoginOutcome =
  | { kind: "login"; userId: string; tokenVersion: number }
  | { kind: "created"; userId: string; tokenVersion: number }
  | { kind: "confirm_link"; userId: string; email: string }
  | { kind: "reject"; code: OidcRejectCode | "oidc_unavailable" };

export interface ResolveOidcLoginResult {
  outcome: OidcLoginOutcome;
  settingsMissing: boolean;
  /** Provider row deleted or `config_version` changed since the callback checked it: only the no-account outcome changes (to `oidc_unavailable`). */
  providerStale: boolean;
}

/**
  * The auto-create switch is read under `site_settings FOR SHARE`, which excludes provider PATCH/DELETE (they take the settings lock
  * first). The provider row is bound to the callback-verified `config_version`: the code exchange sits between that check and this
  * transaction, and claims from a replaced issuer must not create an account. The provider's `enabled` is deliberately not re-checked here.
  * The login branch only updates `user_identities.last_login_at` and never locks the user row (no cycle with SSO proof's
  * user-then-identity order); 0 rows after a concurrent unlink still counts as login. The create branch is registry-first
  * (handles, users, user_identities) and deliberately doesn't write `users.oidc_*`. Unique-key errors are rethrown; the route retries the whole transaction.
  */
export async function resolveOidcLoginInTx(
  tx: Tx,
  input: { claims: OidcClaims; providerId: string; configVersion: number },
  hook?: OidcTestHook,
): Promise<ResolveOidcLoginResult> {
  // Defence in depth: `users_email_unique` is case-sensitive, so an unnormalized email would create a case-only duplicate.
  const claims: OidcClaims = { ...input.claims, email: input.claims.email === null ? null : normalizeEmail(input.claims.email) };
  const settings = await tx
    .select({ singleton: siteSettings.singleton })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  const settingsMissing = settings.length !== 1;
  // Must come after the FOR SHARE read (that lock is what makes this plain read consistent).
  const [providerRow] = await tx
    .select({ autoCreateEnabled: authProviders.autoCreateEnabled })
    .from(authProviders)
    .where(and(eq(authProviders.id, input.providerId), eq(authProviders.configVersion, input.configVersion)))
    .limit(1);
  const providerStale = !settingsMissing && providerRow === undefined;
  const autoCreateEnabled = !settingsMissing && providerRow?.autoCreateEnabled === true;

  const identityQuery = async () =>
    (
      await tx
        .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash, tokenVersion: users.tokenVersion })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.issuer, claims.issuer), eq(userIdentities.sub, claims.sub)))
        .limit(1)
    )[0];
  let hit = await identityQuery();

  if (hit === undefined) await hook?.("login-identity-missed", { issuer: claims.issuer, sub: claims.sub });
  const emailRows =
    hit === undefined && claims.email !== null
      ? await tx
          .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash })
          .from(users)
          .where(sql`lower(${users.email}) = ${claims.email}`)
          .orderBy(asc(users.createdAt), asc(users.id))
      : [];
  // READ COMMITTED snapshots per statement: another first login for the same (issuer, sub) may commit between the two
  // queries, so the email query hits its account while the identity query missed. Re-query the identity before deciding and feed a
  // hit back as the identity input (disabled still gives account_disabled); no separate login shortcut.
  if (emailRows.length > 0) hit = await identityQuery();
  const byIdentityUser: OidcCandidateRow | null =
    hit === undefined ? null : { id: hit.id, disabledAt: hit.disabledAt, hasPassword: hit.passwordHash !== null, linkedProviders: [] };

  const byEmailUsers: OidcCandidateRow[] = [];
  for (const row of hit === undefined ? emailRows : []) {
    byEmailUsers.push({
      id: row.id,
      disabledAt: row.disabledAt,
      hasPassword: row.passwordHash !== null,
      linkedProviders: emailRows.length === 1 ? await linkedEnabledProvidersWithIssuer(tx, row.id) : [],
    });
  }

  const decision = decideOidcLogin(claims, byIdentityUser, byEmailUsers, autoCreateEnabled);
  switch (decision.kind) {
    case "reject":
      return {
        outcome: { kind: "reject", code: decision.code === "registration_disabled" && providerStale ? "oidc_unavailable" : decision.code },
        settingsMissing,
        providerStale,
      };
    case "confirm_link":
      return { outcome: { kind: "confirm_link", userId: decision.userId, email: claims.email! }, settingsMissing, providerStale };
    case "login":
      await tx
        .update(userIdentities)
        .set({ lastLoginAt: sql`now()` })
        .where(and(eq(userIdentities.issuer, claims.issuer), eq(userIdentities.sub, claims.sub)));
      return { outcome: { kind: "login", userId: decision.userId, tokenVersion: hit!.tokenVersion }, settingsMissing, providerStale };
    case "create": {
      const userId = randomUUID();
      const handle = await deriveHandle(tx, [decision.preferredUsername, decision.email.split("@")[0]], userId);
      await tx.insert(handles).values({ handle, userId, state: "live" });
      const [created] = await tx
        .insert(users)
        .values({ id: userId, email: decision.email, displayName: decision.displayName, passwordHash: null, mustChangePassword: false, handle })
        .returning({ tokenVersion: users.tokenVersion });
      await tx.insert(userIdentities).values({ userId, issuer: claims.issuer, sub: claims.sub, lastLoginAt: sql`now()` });
      return { outcome: { kind: "created", userId, tokenVersion: created!.tokenVersion }, settingsMissing, providerStale };
    }
  }
}
