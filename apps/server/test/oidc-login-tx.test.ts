import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { identitiesOf, seedAuthProvider } from "./helpers/oidc-provider.js";
import { authProviders, handles, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { resolveOidcLoginInTx } from "../src/auth/tx/oidc-login.js";
import type { OidcClaims } from "../src/auth/oidc-login-decision.js";
import type { Db } from "../src/db/index.js";

const ISS = "https://idp.example";
const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({ issuer: ISS, sub: "s1", email: "u@example.com", name: "U", preferredUsername: null, ...over });
const run = (db: Db, c: OidcClaims, p: { id: string; configVersion: number }) =>
  db.transaction(tx => resolveOidcLoginInTx(tx, { claims: c, providerId: p.id, configVersion: p.configVersion }));
/** Login service (issuer = ISS); the helper defaults to auto-create on. */
const seedRunProvider = (db: Db, over: { autoCreateEnabled?: boolean; configVersion?: number } = {}) =>
  seedAuthProvider(db, { issuerUrl: ISS, displayName: "Run", ...over });

async function seedUser(db: Db, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ email: "u@example.com", displayName: "Existing", passwordHash: "h", ...over }).returning();
  return u!;
}

describe("resolveOidcLoginInTx (execution layer, #187)", () => {
  it("identity hit -> login: writes only last_login_at; the users row is unchanged column by column (including must_change_password=true)", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db, { mustChangePassword: true });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    const before = await db.select().from(users).where(eq(users.id, u.id));
    const r = await run(db, claims(), p);
    expect(r).toEqual({ outcome: { kind: "login", userId: u.id, tokenVersion: u.tokenVersion }, settingsMissing: false, providerStale: false });
    expect(await db.select().from(users).where(eq(users.id, u.id))).toEqual(before);
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).not.toBeNull();
  });

  it("identity hit but disabled -> reject account_disabled, last_login_at not written", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db, { disabledAt: new Date() });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "account_disabled" });
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).toBeNull();
  });

  it("new email with auto-create on -> created: registry-first, no password, must_change_password=false, **old columns not written**, identity carries last_login_at", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const r = await run(db, claims({ email: "new@example.com", preferredUsername: "Cool.Person" }), p);
    expect(r.outcome.kind).toBe("created");
    const id = (r.outcome as { userId: string }).userId;
    const [u] = await db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ email: "new@example.com", displayName: "U", passwordHash: null, mustChangePassword: false, handle: "cool-person", oidcIssuer: null, oidcSub: null });
    expect(await identitiesOf(db, id)).toEqual([{ issuer: ISS, sub: "s1" }]);
    const [h] = await db.select().from(handles).where(eq(handles.handle, "cool-person"));
    expect(h).toMatchObject({ userId: id, state: "live" });
  });

  it("service without auto-create -> registration_disabled, zero writes; independent of the site switch", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { autoCreateEnabled: false });
    expect(await run(db, claims({ email: "new@example.com" }), p)).toEqual({
      outcome: { kind: "reject", code: "registration_disabled" },
      settingsMissing: false,
      providerStale: false,
    });
    expect(await db.select().from(users)).toHaveLength(0);
    // Site registration_enabled=false with the service on -> still creates the account.
    const b = await buildTestApp();
    await b.db.update(siteSettings).set({ registrationEnabled: false });
    const q = await seedRunProvider(b.db);
    expect((await run(b.db, claims({ email: "new@example.com" }), q)).outcome.kind).toBe("created");
  });

  it("site_settings has no row -> registration_disabled + settingsMissing; deleting the service row too is still registration_disabled, providerStale=false", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await db.delete(siteSettings);
    const expected = { outcome: { kind: "reject", code: "registration_disabled" }, settingsMissing: true, providerStale: false };
    // `.resolves`: if it wrongly goes to account creation (a missing row means no default plan) the transaction throws, which must land as an assertion failure.
    await expect(run(db, claims({ email: "new@example.com" }), p)).resolves.toEqual(expected);
    // providerStale only holds when the site_settings row exists.
    await db.delete(authProviders).where(eq(authProviders.id, p.id));
    await expect(run(db, claims({ email: "new@example.com" }), p)).resolves.toEqual(expected);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("service on but its row deleted -> oidc_unavailable + providerStale, zero writes", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await db.delete(authProviders).where(eq(authProviders.id, p.id));
    expect(await run(db, claims({ email: "new@example.com" }), p)).toEqual({
      outcome: { kind: "reject", code: "oidc_unavailable" },
      settingsMissing: false,
      providerStale: true,
    });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("service on but config_version changed -> oidc_unavailable + providerStale, zero writes; version matches -> created", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { configVersion: 3 });
    expect(await run(db, claims({ email: "new@example.com" }), { id: p.id, configVersion: 2 })).toEqual({
      outcome: { kind: "reject", code: "oidc_unavailable" },
      settingsMissing: false,
      providerStale: true,
    });
    expect(await db.select().from(users)).toHaveLength(0);
    expect((await run(db, claims({ email: "new@example.com" }), p)).outcome.kind).toBe("created");
  });

  it("service without auto-create, or version changed: a linked identity still logs in and an email with an existing account still gets confirm_link (only the account-creation step is affected)", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { autoCreateEnabled: false, configVersion: 2 });
    const cases = [
      { q: { id: p.id, configVersion: 2 }, providerStale: false },
      { q: { id: p.id, configVersion: 1 }, providerStale: true },
    ];
    const u = await seedUser(db);
    for (const { q, providerStale } of cases) {
      expect(await run(db, claims({ sub: "other" }), q)).toEqual({
        outcome: { kind: "confirm_link", userId: u.id, email: "u@example.com" },
        settingsMissing: false,
        providerStale,
      });
    }
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    for (const { q, providerStale } of cases) {
      expect(await run(db, claims(), q)).toEqual({
        outcome: { kind: "login", userId: u.id, tokenVersion: u.tokenVersion },
        settingsMissing: false,
        providerStale,
      });
    }
  });

  it("email already has an account (a mixed-case old row counts) -> confirm_link, zero writes; a disabled account or one with a same-issuer identity is also confirm_link", async () => {
    for (const over of [{ email: "U@Example.com" }, { disabledAt: new Date() }]) {
      const { db } = await buildTestApp();
      const p = await seedRunProvider(db);
      const u = await seedUser(db, over);
      expect((await run(db, claims(), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
      expect(await identitiesOf(db, u.id)).toEqual([]);
    }
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db);
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "older-sub" });
    expect((await run(db, claims(), p)).outcome.kind).toBe("confirm_link");
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: ISS, sub: "older-sub" }]);
  });

  // The outcome carries no methods, so what this layer can see is the consequence of whether a same-issuer provider is counted as a proof
  // method: no_proof_method when it's all a password-less account has, confirm_link when another provider exists. The contents of the providers list are asserted by the unit cases.
  it("SSO-only account already has an ISS identity (different sub) + an enabled provider of another issuer -> confirm_link; the ISS provider doesn't count as a proof method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedAuthProvider(db, { issuerUrl: ISS, displayName: "IdP" });
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", displayName: "B" });
    await db.insert(userIdentities).values([
      { userId: u.id, issuer: ISS, sub: "older-sub" },
      { userId: u.id, issuer: "https://b.example", sub: "bx" },
    ]);
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
    // After B is disabled only ISS remains: if ISS were counted into methods this would be confirm_link.
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, b.id));
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: "https://b.example", sub: "bx" }, { issuer: ISS, sub: "older-sub" }]);
  });

  it("target account has only an ISS identity, no password (ISS provider enabled, resolved_issuer with a trailing slash) -> oidc_link_no_proof_method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedAuthProvider(db, { issuerUrl: `${ISS}/`, resolvedIssuer: `${ISS}/`, displayName: "IdP" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: `${ISS}/`, sub: "older-sub" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });

  it("defence in depth: claims.email in mixed case (not normalized) -> matches the existing lowercase account -> confirm_link (email returned normalized), no account created", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db);
    expect((await run(db, claims({ email: " U@Example.COM " }), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("SSO-only account: linked provider enabled -> confirm_link; provider disabled -> oidc_link_no_proof_method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedRunProvider(db);
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: "https://a.example", sub: "x" });
    expect((await run(db, claims(), p)).outcome.kind).toBe("confirm_link");
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, a.id));
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });

  it("lower(email) matching multiple rows -> oidc_conflict; email missing -> oidc_email_missing", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await seedUser(db, { email: "u@example.com" });
    await seedUser(db, { email: "U@EXAMPLE.com" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_conflict" });
    expect((await run(db, claims({ email: null, sub: "zz" }), p)).outcome).toEqual({ kind: "reject", code: "oidc_email_missing" });
  });

  it("while a transaction holding the site_settings row lock has switched the service flag to false but not committed, the first-login transaction is stuck on site_settings FOR SHARE; after commit it gets registration_disabled", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const pool = db.$client;
    const closer = await pool.connect();
    try {
      await closer.query("begin");
      await closer.query("select singleton from site_settings for no key update");
      await closer.query("update auth_providers set auto_create_enabled = false where id = $1", [p.id]);
      const login = run(db, claims({ email: "new@example.com" }), p);
      expect(await waitForBlockedOrSettled(pool, login)).toBe("blocked");
      await closer.query("commit");
      expect((await login).outcome).toEqual({ kind: "reject", code: "registration_disabled" });
    } finally {
      await closer.query("rollback").catch(() => undefined);
      closer.release();
    }
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
