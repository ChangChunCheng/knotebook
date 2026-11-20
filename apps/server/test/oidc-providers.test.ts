import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { GENERIC } from "./helpers/provider-icon.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { linkedEnabledProvidersWithIssuer, listEnabledProvidersForConfig, loadEnabledProvider, loadLegacyProvider, openClientSecret, providerConfiguration, recordResolvedIssuer } from "../src/auth/oidc-providers.js";
import { SecretDecryptError } from "../src/lib/sealed-secret.js";

describe("auth/oidc-providers (#187)", () => {
  it("recordResolvedIssuer: version predicate: an old version doesn't overwrite a new config; same value isn't written; NULL -> written", async () => {
    const { db } = await buildTestApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/" });
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://gitlab.example")).toBe(true);
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://gitlab.example")).toBe(false);
    await db.update(authProviders).set({ configVersion: 2, resolvedIssuer: null }).where(eq(authProviders.id, p.id));
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://stale.example")).toBe(false);
    const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, p.id));
    expect(row!.r).toBeNull();
  });

  it("providerConfiguration: trailing-slash form: provider is https://gitlab.example/, IdP returns without the slash -> succeeds and resolved_issuer is written without the slash; uppercase host likewise", async () => {
    for (const [issuerUrl, idpIssuer] of [["https://gitlab.example/", "https://gitlab.example"], ["https://GitLab.Example", "https://gitlab.example"]] as const) {
      const { db } = await buildTestApp();
      const idp = createFakeIdp(idpIssuer);
      const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
      const p = await seedAuthProvider(db, { issuerUrl });
      const conf = await providerConfiguration({ db, registry, appSecret: testConfig.appSecret }, p);
      expect(conf.serverMetadata().issuer).toBe(idpIssuer);
      const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, p.id));
      expect(row!.r).toBe(idpIssuer);
    }
  });

  it("openClientSecret: AAD is bound to the provider id: moving A's ciphertext to B can't be decrypted; secret NULL -> SecretDecryptError", async () => {
    const { db } = await buildTestApp();
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example", clientSecret: "secret-a" });
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", clientSecret: null, enabled: false });
    expect(openClientSecret(testConfig.appSecret, a)).toBe("secret-a");
    expect(() => openClientSecret(testConfig.appSecret, { id: b.id, clientSecretEncrypted: a.clientSecretEncrypted })).toThrow(SecretDecryptError);
    expect(() => openClientSecret(testConfig.appSecret, b)).toThrow(SecretDecryptError);
  });

  it("queries: loadEnabledProvider doesn't return disabled ones; loadLegacyProvider returns only an enabled legacy; listEnabledProvidersForConfig lists only enabled, ordered by sort_order, with only id, displayName and icon", async () => {
    const { db } = await buildTestApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: "https://l.example", legacyCallback: true, displayName: "Legacy", sortOrder: 5 });
    const g = await seedAuthProvider(db, { issuerUrl: "https://g.example", displayName: "G", sortOrder: 1 });
    const off = await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false });
    expect((await loadEnabledProvider(db, g.id))?.id).toBe(g.id);
    expect(await loadEnabledProvider(db, off.id)).toBeNull();
    expect((await loadLegacyProvider(db))?.id).toBe(legacy.id);
    expect(await listEnabledProvidersForConfig(db)).toEqual({
      providers: [{ id: g.id, displayName: "G", icon: GENERIC }, { id: legacy.id, displayName: "Legacy", icon: GENERIC }],
      autoCreateProviderIds: [g.id, legacy.id],
    });
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, legacy.id));
    expect(await loadLegacyProvider(db)).toBeNull();
  });

  it("linkedEnabledProvidersWithIssuer: matches identities by effective issuer = coalesce(resolved_issuer, issuer_url); disabled ones aren't listed", async () => {
    const { db } = await buildTestApp();
    const [u] = await db.insert(users).values({ email: "u@x", displayName: "U" }).returning();
    const slash = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/", resolvedIssuer: "https://gitlab.example", displayName: "GitLab" });
    await seedAuthProvider(db, { issuerUrl: "https://other.example", displayName: "Other" });
    const off = await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false });
    await db.insert(userIdentities).values([
      { userId: u!.id, issuer: "https://gitlab.example", sub: "1" },
      { userId: u!.id, issuer: "https://off.example", sub: "2" },
    ]);
    expect(await linkedEnabledProvidersWithIssuer(db, u!.id)).toEqual([{ id: slash.id, displayName: "GitLab", icon: GENERIC, effectiveIssuer: "https://gitlab.example" }]);
    // With resolved_issuer NULL it falls back to the issuer_url literal: a literal with a trailing slash doesn't match a slash-less identity.
    await db.update(authProviders).set({ resolvedIssuer: null }).where(eq(authProviders.id, slash.id));
    expect(await linkedEnabledProvidersWithIssuer(db, u!.id)).toEqual([]);
    expect(off.enabled).toBe(false);
  });
});
