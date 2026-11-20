import { describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { identitiesOf, legacyOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import type { AppConfig } from "../src/config.js";
import { OIDC_STATE_COOKIE_PATH, sealOidcState, unsealOidcState } from "../src/auth/oidc-state.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import type { OidcProviderRow } from "../src/auth/oidc-providers.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { userIdentities, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { UserGate } from "../src/auth/session.js";
import type { Db } from "../src/db/index.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const ISSUER_URL = "https://idp.example.com";

async function loginAndAuthorize(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  fakeIdp: FakeIdp,
  claims: FakeIdpClaims
): Promise<{ code: string; state: string; cookieValue: string; loginRes: InjectResponse }> {
  fakeIdp.setNextLogin(claims);
  const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  const location = loginRes.headers.location as string;
  const { code, state } = fakeIdp.authorize(location);
  const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  return { code, state, cookieValue, loginRes };
}

function callback(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  params: { code?: string; state?: string; cookieValue?: string }
): Promise<InjectResponse> {
  const query = new URLSearchParams();
  if (params.code !== undefined) query.set("code", params.code);
  if (params.state !== undefined) query.set("state", params.state);
  return app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?${query.toString()}`,
    cookies: params.cookieValue !== undefined ? { [OIDC_STATE_COOKIE]: params.cookieValue } : {},
  });
}

function assertStateMismatch(res: InjectResponse): void {
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
  const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
  expect(cookie).toBeDefined();
  expect(cookie?.value).toBe("");
  expect(cookie?.path).toBe(OIDC_STATE_COOKIE_PATH);
}

async function insertUser(
  db: Db,
  overrides: Partial<typeof users.$inferInsert> & { email: string }
): Promise<typeof users.$inferSelect> {
  const [row] = await db
    .insert(users)
    .values({
      displayName: overrides.email.split("@")[0] ?? overrides.email,
      ...overrides,
    })
    .returning();
  return row!;
}

async function fetchUserByEmail(db: Db, email: string): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
}

/**
 * Seeds a legacy provider (old URL: this file also guards bookmark compatibility) plus an in-process fake IdP. Identity is stored in
 * user_identities under the IdP's metadata.issuer (= ISSUER_URL); the new code never writes `users.oidc_*`.
 */
async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  db: Db;
  config: AppConfig;
  fakeIdp: FakeIdp;
  provider: OidcProviderRow;
}> {
  const fakeIdp = createFakeIdp(ISSUER_URL);
  const { app, db, config, provider } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);
  return { app, db, config, fakeIdp, provider };
}

describe("GET /api/auth/oidc/callback", () => {
  it("state cookie missing -> 302 oidc_state_mismatch, with a clearing cookie", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state } = await loginAndAuthorize(app, fakeIdp, { sub: "u1", email: "new@example.com", email_verified: true });
    const res = await callback(app, { code, state });
    assertStateMismatch(res);
  });

  it("state cookie expired (exp) -> 302 oidc_state_mismatch, with a clearing cookie", async () => {
    const { app, config, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    const now = Math.floor(Date.now() / 1000);
    const payload = unsealOidcState(config.appSecret, cookieValue, now)!;
    const expiredCookie = sealOidcState(config.appSecret, { ...payload, exp: now - 1 });
    const res = await callback(app, { code, state, cookieValue: expiredCookie });
    assertStateMismatch(res);
  });

  it("query state doesn't match the payload -> 302 oidc_state_mismatch, with a clearing cookie", async () => {
    const { app, fakeIdp } = await setup();
    const { code, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    const res = await callback(app, { code, state: "wrong-state", cookieValue });
    assertStateMismatch(res);
  });

  it("token exchange failure (token endpoint 500) -> 302 oidc_exchange_failed", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    fakeIdp.failNext("token");
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
    // The exchange failure path also clears the state cookie (cleared on success and failure, not only on state_mismatch).
    const clearedCookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(clearedCookie?.value).toBe("");
    expect(clearedCookie?.path).toBe(OIDC_STATE_COOKIE_PATH);
  });

  describe("callback's own oidc_unavailable (covered per endpoint, not just login)", () => {
    it("no legacy provider -> 302 oidc_unavailable; legacy provider disabled -> same (the provider check runs before the cookie is unsealed, no next)", async () => {
      const { app, db } = await buildTestApp();
      const none = await callback(app, {});
      expect(none.statusCode).toBe(302);
      expect(none.headers.location).toBe("/login?error=oidc_unavailable");

      await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true, enabled: false });
      const disabled = await callback(app, {});
      expect(disabled.statusCode).toBe(302);
      expect(disabled.headers.location).toBe("/login?error=oidc_unavailable");
    });

    it("discovery failure (hit when callback itself calls getConfiguration, not reusing a successful result cached by login) -> 302 oidc_unavailable", async () => {
      const { app, config, fakeIdp, provider } = await setup();
      fakeIdp.failNext("discovery");
      // Hand-seal a valid state cookie (bypassing the login route): running login first would make discovery succeed and cache there,
      // and callback wouldn't exercise "callback's own first getConfiguration() fails". The hand-sealed cookie must also carry the
      // required fields (bound to the seeded legacy provider, current version, intent login), otherwise it falls to oidc_state_mismatch
      // at the providerId check before discovery.
      const state = "manual-state";
      const nonce = "manual-nonce";
      const codeVerifier = "manual-code-verifier";
      const nowEpochSeconds = Math.floor(Date.now() / 1000);
      const cookieValue = sealOidcState(config.appSecret, {
        state,
        nonce,
        codeVerifier,
        exp: nowEpochSeconds + 600,
        providerId: provider.id,
        configVersion: provider.configVersion,
        intent: "login",
      });

      const res = await callback(app, { code: "irrelevant-code", state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
      // Really reached discovery (not an earlier state check): callback called it exactly once.
      expect(fakeIdp.counts.discovery).toBe(1);
    });

    it("provider id is not a UUID (/api/auth/oidc/callback/not-a-uuid) -> 302 oidc_unavailable, IdP untouched (discovery 0 times)", async () => {
      const { app, fakeIdp } = await setup();
      const res = await app.inject({ method: "GET", url: "/api/auth/oidc/callback/not-a-uuid?code=x&state=y" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
      expect(fakeIdp.counts.discovery).toBe(0);
    });
  });

  it("email claim is an empty string -> treated as missing, 302 oidc_email_missing (no account with email='' is created)", async () => {
    const { app, db, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "empty-email-sub",
      email: "",
      email_verified: true,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_email_missing");
    expect(await fetchUserByEmail(db, "")).toBeUndefined();
  });

  describe("account resolution matrix", () => {
    it("brand-new email -> creates the account and logs in; identity written to user_identities (issuer = IdP's metadata.issuer), old users.oidc_* columns not written", async () => {
      const { app, db, fakeIdp } = await setup();
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "new-sub",
        email: "New.User@Example.com",
        email_verified: true,
        name: "New User",
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeDefined();

      const row = await fetchUserByEmail(db, "new.user@example.com");
      expect(row).toBeDefined();
      expect(await identitiesOf(db, row!.id)).toEqual([{ issuer: ISSUER_URL, sub: "new-sub" }]);
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();
      expect(row?.passwordHash).toBeNull();
      expect(row?.email).toBe("new.user@example.com");

      // Pinned by passing it along: after OIDC auto-creates the account, the session cookie hits /api/auth/me -> hasPassword:false.
      const oidcCookie = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oidcCookie } });
      expect(me.json().hasPassword).toBe(false);
    });

    it("gate cache: create branch (users written) -> gate.invalidate(new account) exactly once; same identity logging in again (login branch, users not written) -> no invalidate", async () => {
      // A new account's id is a uuid generated inside the transaction, so the gate can't have cached it beforehand: a missing invalidate has no HTTP-observable consequence, only a spy shows it.
      const invalidate = vi.spyOn(UserGate.prototype, "invalidate");
      onTestFinished(() => invalidate.mockRestore());
      const { app, db, fakeIdp } = await setup();
      const claims: FakeIdpClaims = { sub: "gate-inv-sub", email: "gate-inv@example.com", name: "G" };

      const created = await callback(app, await loginAndAuthorize(app, fakeIdp, claims));
      expect(created.headers.location).toBe("/");
      const row = await fetchUserByEmail(db, "gate-inv@example.com");
      expect(invalidate.mock.calls).toEqual([[row!.id]]);

      invalidate.mockClear();
      const loggedIn = await callback(app, await loginAndAuthorize(app, fakeIdp, claims));
      expect(loggedIn.headers.location).toBe("/");
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("email matches an existing account (has password, not linked) -> 302 /link-account: no session, pending cookie sealed, zero writes (no auto-link); password login still works", async () => {
      const { app, db, fakeIdp } = await setup();
      const existing = await insertUser(db, { email: "existing@example.com", passwordHash: await hashPassword("Password123!") });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "existing-sub",
        email: "existing@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBeTruthy();
      expect(await identitiesOf(db, existing.id)).toEqual([]);
      const row = await fetchUserByEmail(db, "existing@example.com");
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();

      // Password path still works (untouched by this SSO).
      const passwordLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "Password123!" },
      });
      expect(passwordLogin.statusCode).toBe(200);
    });

    it("account already linked to another sub of the same issuer -> still /link-account before proof (doesn't reveal that the same issuer was linked), original identity untouched", async () => {
      const { app, db, fakeIdp } = await setup();
      // Needs a password: a provider of the same issuer isn't listed as a proof method (listing it would tell the other side before proof
      // that "this account already linked this IdP"), so a password-less SSO-only account lands on oidc_link_no_proof_method here and wouldn't test the path under test.
      const row0 = await insertUser(db, { email: "conflict@example.com", passwordHash: await hashPassword("Password123!") });
      await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "original-sub" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "different-sub",
        email: "conflict@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(await identitiesOf(db, row0.id)).toEqual([{ issuer: ISSUER_URL, sub: "original-sub" }]);
    });

    it("disabled account via email (has password, not linked) -> 302 /link-account (disabled not revealed before proof), no session, zero writes", async () => {
      const { app, db, fakeIdp } = await setup();
      // Needs a password: an account with no password and no linked provider lands on oidc_link_no_proof_method, which wouldn't test "exclude the same-issuer pending identity".
      const row0 = await insertUser(db, {
        email: "disabled@example.com",
        passwordHash: await hashPassword("Password123!"),
        disabledAt: new Date(),
      });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-sub",
        email: "disabled@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(await identitiesOf(db, row0.id)).toEqual([]);
    });

    it("disabled account hit by (issuer, sub) -> 302 account_disabled, last_login_at not written", async () => {
      const { app, db, fakeIdp } = await setup();
      const row0 = await insertUser(db, { email: "disabled2@example.com", disabledAt: new Date() });
      await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "disabled-idsub" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-idsub",
        email: "disabled2@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=account_disabled");
      const [identity] = await db.select().from(userIdentities).where(eq(userIdentities.userId, row0.id));
      expect(identity!.lastLoginAt).toBeNull();
    });
  });

  describe("userinfo top-up matrix", () => {
    it("ID token has email but no email_verified -> userinfo not called, account created from the ID token's email even if userinfo would return another email", async () => {
      const { app, db, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email_verified"]);
      // Preset a diverging userinfo: if any code path called userinfo extra and adopted its email, the two fetchUserByEmail assertions below would flip.
      fakeIdp.overrideNextUserinfo({ email: "userinfo-diverged@example.com" });
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv1",
        email: "uv1@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(0);
      expect(await fetchUserByEmail(db, "uv1@example.com")).toBeDefined();
      expect(await fetchUserByEmail(db, "userinfo-diverged@example.com")).toBeUndefined();
    });

    it("only email missing -> userinfo called exactly once, merged result succeeds", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv2",
        email: "uv2@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });

    it("both missing -> userinfo called exactly once, merged result succeeds", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email", "email_verified"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv3",
        email: "uv3@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });

    it("metadata has no userinfo_endpoint -> not called, follows the matching error for the missing fields", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      fakeIdp.omitFromMetadata(["userinfo_endpoint"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv4",
        email: "uv4@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_missing");
      expect(fakeIdp.counts.userinfo).toBe(0);
    });

    it("userinfo 500 (only called when the ID token lacks email) -> 302 oidc_exchange_failed", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv5",
        email: "uv5@example.com",
        email_verified: true,
      });
      fakeIdp.failNext("userinfo");
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });
  });

  it("mixed-case email claim matching an existing lowercase account (with password) -> /link-account, no account created, no unique violation; pending carries the normalized email", async () => {
    const { app, db, config, fakeIdp } = await setup();
    const existing = await insertUser(db, { email: "mixed@example.com", passwordHash: await hashPassword("Password123!") });

    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "mixed-sub",
      email: "Mixed@Example.com",
      email_verified: true,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/link-account");

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await identitiesOf(db, existing.id)).toEqual([]);
    const pending = res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(unsealPendingLink(config.appSecret, pending.value, Math.floor(Date.now() / 1000))).toMatchObject({
      userId: existing.id,
      email: "mixed@example.com",
      sub: "mixed-sub",
    });
  });

  it("idempotent: the same (issuer, sub) calling back twice -> no account rebuilt, no duplicate identity, logs in directly", async () => {
    const { app, db, fakeIdp } = await setup();
    const claims: FakeIdpClaims = { sub: "idem-sub", email: "idem@example.com", email_verified: true };

    const first = await loginAndAuthorize(app, fakeIdp, claims);
    const res1 = await callback(app, first);
    expect(res1.statusCode).toBe(302);
    expect(res1.headers.location).toBe("/");

    const second = await loginAndAuthorize(app, fakeIdp, claims);
    const res2 = await callback(app, second);
    expect(res2.statusCode).toBe(302);
    expect(res2.headers.location).toBe("/");

    const rows = await db.select().from(users).where(eq(users.email, "idem@example.com"));
    expect(rows).toHaveLength(1);
    expect(await identitiesOf(db, rows[0]!.id)).toEqual([{ issuer: ISSUER_URL, sub: "idem-sub" }]);
  });

  it("race: two concurrent callbacks creating the same email account -> the unique-key collision re-runs the whole transaction once and the re-check hits the identity, both 302 / (not 500)", async () => {
    const { app, db, fakeIdp } = await setup();
    const claims: FakeIdpClaims = { sub: "race-sub", email: "race@example.com", email_verified: true };

    const first = await loginAndAuthorize(app, fakeIdp, claims);
    const second = await loginAndAuthorize(app, fakeIdp, claims);

    const [res1, res2] = await Promise.all([callback(app, first), callback(app, second)]);

    expect(res1.statusCode).toBe(302);
    expect(res1.headers.location).toBe("/");
    expect(res2.statusCode).toBe(302);
    expect(res2.headers.location).toBe("/");

    const rows = await db.select().from(users).where(eq(users.email, "race@example.com"));
    expect(rows).toHaveLength(1);
    expect(await identitiesOf(db, rows[0]!.id)).toEqual([{ issuer: ISSUER_URL, sub: "race-sub" }]);
    expect(rows[0]?.oidcSub).toBeNull();
  });

  /**
   * Deterministic interleaving: B enters callback first and stops at `login-identity-missed` (identity lookup missed, before the email
   * lookup); A completes a first login with the same (issuer, sub) and commits; `afterA` lets the test touch the DB again before B is released; finally B is released.
   */
  async function interleaveFirstLogins(
    sub: string,
    email: string,
    afterA: (db: Db, userId: string) => Promise<void> = async () => {},
  ): Promise<{ db: Db; resB: InjectResponse; points: string[]; userId: string }> {
    const gate = { release: () => {} };
    const held = new Promise<void>(resolve => (gate.release = resolve));
    const parked = { resolve: () => {} };
    const bParked = new Promise<void>(resolve => (parked.resolve = resolve));
    const points: string[] = [];
    let first = true;
    const hook: OidcTestHook = async point => {
      points.push(point);
      if (point === "login-identity-missed" && first) {
        first = false;
        parked.resolve();
        await held;
      }
    };
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, db } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL, { oidcTestHook: hook });
    const claims: FakeIdpClaims = { sub, email, email_verified: true };
    const forB = await loginAndAuthorize(app, fakeIdp, claims);
    const forA = await loginAndAuthorize(app, fakeIdp, claims);

    let bSettled = false;
    const pB = callback(app, forB).finally(() => {
      bSettled = true;
    });
    await bParked;
    let userId: string;
    try {
      const pA = callback(app, forA);
      // A must not be blocked by B (B only holds site_settings FOR SHARE here): A runs through and commits while B is still stopped between the identity lookup and the email lookup.
      expect(await waitForBlockedOrSettled(db.$client, pA)).toBe("settled");
      const resA = await pA;
      expect(resA.statusCode).toBe(302);
      expect(resA.headers.location).toBe("/");
      expect(bSettled).toBe(false);
      const rows = await db.select().from(users).where(eq(users.email, email));
      expect(rows).toHaveLength(1);
      userId = rows[0]!.id;
      await afterA(db, userId);
    } finally {
      gate.release();
    }
    const resB = await pB;
    return { db, resB, points, userId };
  }

  it("race (deterministic interleaving): after B's identity lookup misses and before its email lookup, A creates the account with the same (issuer, sub) and commits -> B's re-check in the same transaction hits the identity, takes the login 302 / (not oidc_link_no_proof_method)", async () => {
    const { db, resB, points, userId } = await interleaveFirstLogins("toctou-sub", "toctou@example.com");
    expect(resB.statusCode).toBe(302);
    expect(resB.headers.location).toBe("/");
    expect(resB.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    // B stops once and A passes once; B did not retry after a unique-key collision (a retry would pass this point again).
    expect(points).toEqual(["login-identity-missed", "login-identity-missed"]);

    const rows = await db.select().from(users).where(eq(users.email, "toctou@example.com"));
    expect(rows).toHaveLength(1);
    expect(await identitiesOf(db, userId)).toEqual([{ issuer: ISSUER_URL, sub: "toctou-sub" }]);
  });

  it("race (deterministic interleaving): same as above, but A's account is disabled before B is released -> after B's re-check hits the identity it judges account_disabled as in the normal path (no login shortcut, no session)", async () => {
    const lastLogin = async (d: Db, id: string) =>
      (await d.$client.query<{ t: string }>("select last_login_at::text as t from user_identities where user_id = $1", [id])).rows[0]!.t;
    let lastLoginByA = "";
    const { db, resB, points, userId } = await interleaveFirstLogins("toctou-dis-sub", "toctou-dis@example.com", async (d, id) => {
      lastLoginByA = await lastLogin(d, id);
      await d.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id));
    });
    expect(resB.statusCode).toBe(302);
    expect(resB.headers.location).toBe("/login?error=account_disabled");
    expect(resB.cookies.find(c => c.name === SESSION_COOKIE)?.value ?? "").toBe("");
    expect(points).toEqual(["login-identity-missed", "login-identity-missed"]);
    expect(await identitiesOf(db, userId)).toEqual([{ issuer: ISSUER_URL, sub: "toctou-dis-sub" }]);
    // The disabled branch doesn't write last_login_at: it is still the value written when A created the account.
    expect(lastLoginByA).not.toBe("");
    expect(await lastLogin(db, userId)).toBe(lastLoginByA);
  });

  it("mustChangePassword:true account logging in via SSO with a linked identity -> 302 /, flag not cleared (/api/auth/me and DB both still true); a warm gate cache doesn't return a wrong value either", async () => {
    const { app, db, fakeIdp } = await setup();
    const row0 = await insertUser(db, {
      email: "gatecache@example.com",
      passwordHash: await hashPassword("Password123!"),
      mustChangePassword: true,
    });
    await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "gatecache-sub" });

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "gatecache@example.com", password: "Password123!" },
    });
    expect(passwordLogin.statusCode).toBe(200);
    const passwordCookie = passwordLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    // Warm the gate cache: the login branch doesn't write users or invalidate: the cached value is right, this step guards that it doesn't produce a wrong one as a result.
    const meBefore = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: passwordCookie } });
    expect(meBefore.json().mustChangePassword).toBe(true);

    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "gatecache-sub",
      email: "gatecache@example.com",
      email_verified: true,
    });
    const callbackRes = await callback(app, { code, state, cookieValue });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe("/");
    const oidcCookie = callbackRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oidcCookie } });
    expect(meAfter.statusCode).toBe(200);
    expect(meAfter.json().mustChangePassword).toBe(true);

    const row = await fetchUserByEmail(db, "gatecache@example.com");
    expect(row?.mustChangePassword).toBe(true);

    // Password is still valid (SSO login doesn't touch the password).
    const passwordLoginAgain = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "gatecache@example.com", password: "Password123!" },
    });
    expect(passwordLoginAgain.statusCode).toBe(200);
  });

  it("callback limiter: the 30th request from the same IP still passes, the 31st -> 302 too_many_requests (not JSON)", async () => {
    const { app } = await setup();

    let res: InjectResponse | undefined;
    for (let i = 0; i < 31; i += 1) {
      res = await callback(app, {});
      if (i === 29) {
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
      }
    }
    expect(res!.statusCode).toBe(302);
    expect(res!.headers.location).toBe("/login?error=too_many_requests");
    // Not JSON: the 302 redirect itself has no JSON body/content-type (if present it shouldn't be json).
    if (res!.headers["content-type"] !== undefined) {
      expect(res!.headers["content-type"]).not.toMatch(/json/);
    }
  });
});

// Callback return-to: success goes to the next in the state cookie (or `/`); failures redirecting to /login?error=... carry next too
// once the cookie has been unsealed (part of the normal OIDC flow: after fixing the error the user needs to get back to the original
// page). Exits before the cookie is unsealed (cookie missing, unseal failure, rate limit, not configured) can't get next, so their redirects
// carry no next.
describe("callback return-to (#131)", () => {
  const claims: FakeIdpClaims = { sub: "s-131", email: "next@example.com", email_verified: true, name: "Next" };

  /** `prepare` tampers with the fake IdP before login (e.g. removes userinfo). */
  async function flowWithNext(
    nextQuery: string,
    overrideClaims: FakeIdpClaims = claims,
    prepare: (fakeIdp: FakeIdp) => void = () => {},
  ): Promise<string> {
    const { app, fakeIdp } = await setup();
    prepare(fakeIdp);
    fakeIdp.setNextLogin(overrideClaims);
    const loginRes = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/login?next=${encodeURIComponent(nextQuery)}`,
    });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    return res.headers.location as string;
  }

  it("success -> goes to next (not `/`)", async () => {
    expect(await flowWithNext("/n/alice/my-note?x=1")).toBe("/n/alice/my-note?x=1");
  });

  it("no next -> still `/` (existing behaviour unchanged)", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, claims);

    const res = await callback(app, { code, state, cookieValue });

    expect(res.headers.location).toBe("/");
  });

  it("2049-char next -> falls to `/` (cross-layer smoke; the length gate itself is guarded by oidc-login.test.ts's 2048/2049 case)", async () => {
    expect(await flowWithNext("/" + "a".repeat(2048))).toBe("/");
  });

  it("validated again after unseal: a hand-sealed cookie with a cross-site next -> falls to `/`", async () => {
    // This shape exercises the "validate again after unseal" line on its own: in the normal flow login already blocks it,
    // only a forged payload (or a criterion tightened later while old cookies are still in flight) reaches it.
    const { app, config, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, claims);
    const payload = unsealOidcState(config.appSecret, cookieValue, Math.floor(Date.now() / 1000))!;
    // The payload is a union (the prove form has no next): narrow first, then spread, else `{ ...payload, next }` is TS2345.
    if (payload.intent !== "login") throw new Error("unreachable：login 端點封的 state cookie 一定是 login 形");
    const tampered = sealOidcState(config.appSecret, { ...payload, next: "//evil.example" });

    const res = await callback(app, { code, state, cookieValue: tampered });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("failure (email missing) -> /login?error=...&next=... (next encoded)", async () => {
    // Failure made with a missing email (the ID token has no email and metadata has no userinfo endpoint, so nothing to fill it): a failure in the decision layer after the cookie is unsealed.
    const noEmail: FakeIdpClaims = { sub: "s-131b", name: "U" };

    expect(
      await flowWithNext("/n/alice/my-note?x=1", noEmail, idp => idp.omitFromMetadata(["userinfo_endpoint"])),
    ).toBe("/login?error=oidc_email_missing&next=%2Fn%2Falice%2Fmy-note%3Fx%3D1");
  });

  it("state parameter mismatch (cookie unsealed, next known) -> the error redirect carries next too", async () => {
    const { app, fakeIdp } = await setup();
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    const { code } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;

    const res = await callback(app, { code, state: "not-the-state", cookieValue });

    expect(res.headers.location).toBe("/login?error=oidc_state_mismatch&next=%2Fn%2Falice%2Fmy-note");
  });

  it("cookie missing but query has next -> no next, verbatim (must not be taken from the query)", async () => {
    // The **only** source of `next` is the sealed cookie: taking it from the query would let an attacker decide where someone is sent
    // after a failure with their own link. The query must really carry next, otherwise this case is always green: not taking it gives the same string anyway.
    const { app } = await setup();

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=c&state=s&next=%2Fattacker-page",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
  });

  it("cookie and query each carry a next -> the cookie's is used (query doesn't take part)", async () => {
    // The previous case guards "not taken before unsealing"; this one "not taken after unsealing either": without either, a `query ?? payload` style leaves half unkilled.
    const { app, fakeIdp } = await setup();
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${code}&state=${state}&next=%2Fattacker-page`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/n/alice/my-note");
  });
});
