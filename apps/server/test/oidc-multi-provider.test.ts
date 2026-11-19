import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CustomFetch } from "openid-client";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { buildOidcApp, identitiesOf, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { authProviders, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { sealCookieJson } from "../src/auth/sealed-cookie.js";
import { backfillLegacyOidcIdentities } from "../src/auth/legacy-identities.js";
import pino from "pino";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const now = () => Math.floor(Date.now() / 1000);
const silent = pino({ level: "silent" });
const STALE_MSG = "登入進行期間服務設定已變或已刪：SSO 首登視同關閉";

/**
 * Inserts a one-shot action before the code exchange (fake IdP `/token`): callback has loaded the service and verified the version,
 * the login transaction hasn't opened. `beforeToken` is cleared once consumed.
 */
async function appWithTokenHook(seed: { autoCreateEnabled?: boolean } = {}) {
  const idp = createFakeIdp(A);
  let beforeToken: (() => Promise<void>) | null = null;
  const wrapped: CustomFetch = async (url, options) => {
    if (new URL(String(url)).pathname.endsWith("/token") && beforeToken !== null) {
      const fn = beforeToken;
      beforeToken = null;
      await fn();
    }
    return idp.fetch(url, options);
  };
  const logs = captureLogs();
  const { app, db } = await buildTestApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: wrapped }) }, logs.options);
  const provider = await seedAuthProvider(db, { issuerUrl: A, ...seed });
  const setBeforeToken = (fn: () => Promise<void>) => {
    beforeToken = fn;
  };
  return { app, db, idp, logs, provider, setBeforeToken };
}

describe("login/callback with multiple providers (#187)", () => {
  it("redirect_uri literal: a normal provider is <PUBLIC_URL>/api/auth/oidc/callback/<id>, legacy is the old path; both complete and create an account", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "l", issuerUrl: B, legacyCallback: true }] });
    const a = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "a@x.example", name: "A" } });
    expect(a.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${t.provider("a").id}`);
    expect(a.callbackRes.headers.location).toBe("/");
    const l = await ssoRoundTrip(t.app, t.idp("l"), { loginUrl: "/api/auth/oidc/login", claims: { sub: "sl", email: "l@x.example", name: "L" } });
    expect(l.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
    expect(l.callbackRes.headers.location).toBe("/");
    // The id-carrying entry also works against the legacy provider (redirect_uri is still the old path: legacy doesn't offer switching).
    const l2 = await ssoRoundTrip(t.app, t.idp("l"), { loginUrl: `/api/auth/oidc/login/${t.provider("l").id}`, claims: { sub: "sl", email: "l@x.example" } });
    expect(l2.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
    expect(l2.callbackRes.headers.location).toBe("/");
  });

  it("account created via A, B (different issuer) first login with the same email -> no auto-merge: 302 /link-account, pending cookie carries B's identity and the target account, zero writes", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B, displayName: "B" }] });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "same@x.example" } });
    const [u] = await t.db.select().from(users).where(eq(users.email, "same@x.example"));
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}?next=%2Fn%2Falice%2Fx`, claims: { sub: "sb", email: "Same@X.example" } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(r.callbackRes.headers.location).toBe("/link-account");
    expect(r.callbackRes.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
    const pc = r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(pc).toMatchObject({ path: "/api/auth/oidc", httpOnly: true, sameSite: "Lax", maxAge: 900 });
    expect(unsealPendingLink(testConfig.appSecret, pc.value, now())).toMatchObject({
      issuer: B, sub: "sb", providerId: t.provider("b").id, userId: u!.id, email: "same@x.example", next: "/n/alice/x",
    });
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sa" }]);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("state cookie: providerId mismatch -> oidc_state_mismatch; version changed after login -> oidc_unavailable; old format (no providerId) -> oidc_state_mismatch", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    const swapped = await ssoRoundTrip(t.app, t.idp("a"), {
      loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "s", email: "s@x.example" },
      callbackPath: `/api/auth/oidc/callback/${t.provider("b").id}`,
    });
    expect(swapped.callbackRes.headers.location).toBe("/login?error=oidc_state_mismatch");

    t.idp("a").setNextLogin({ sub: "s", email: "s@x.example" });
    const loginRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${t.provider("a").id}` });
    const { code, state } = t.idp("a").authorize(loginRes.headers.location as string);
    await t.db.update(authProviders).set({ configVersion: 2 }).where(eq(authProviders.id, t.provider("a").id));
    const cookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const stale = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_STATE_COOKIE]: cookie } });
    expect(stale.headers.location).toBe("/login?error=oidc_unavailable");

    const old = sealCookieJson(testConfig.appSecret, "oidc-state", { state: "x", nonce: "y", codeVerifier: "z", exp: now() + 600 });
    const oldRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("b").id}?code=c&state=x`, cookies: { [OIDC_STATE_COOKIE]: old } });
    expect(oldRes.headers.location).toBe("/login?error=oidc_state_mismatch");
  });

  it("disabled: login and callback both refuse (oidc_unavailable); re-enabling restores; recreated with the same issuer after deletion -> the original identity logs in as usual", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "sa", email: "a@x.example" } });
    const [u] = await t.db.select().from(users);
    t.idp("a").setNextLogin({ sub: "sa", email: "a@x.example" });
    const loginRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${id}` });
    const { code, state } = t.idp("a").authorize(loginRes.headers.location as string);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, id));
    expect((await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${id}` })).headers.location).toBe("/login?error=oidc_unavailable");
    const cookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${id}?code=${code}&state=${state}`, cookies: { [OIDC_STATE_COOKIE]: cookie } });
    expect(cb.headers.location).toBe("/login?error=oidc_unavailable");
    await t.db.update(authProviders).set({ enabled: true }).where(eq(authProviders.id, id));
    expect((await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "sa", email: "a@x.example" } })).callbackRes.headers.location).toBe("/");
    await t.db.delete(authProviders).where(eq(authProviders.id, id));
    const again = await seedAuthProvider(t.db, { issuerUrl: A });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${again.id}`, claims: { sub: "sa", email: "a@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sa" }]);
  });

  it("service without auto-create: new email -> /login?error=registration_disabled, no account; linked identity still logs in", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A, autoCreateEnabled: true }] });
    const id = t.provider("a").id;
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "old", email: "old@x.example" } });
    await t.db.update(authProviders).set({ autoCreateEnabled: false });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "new", email: "new@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=registration_disabled");
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect((await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "old", email: "old@x.example" } })).callbackRes.headers.location).toBe("/");
  });

  it("same site, A on and B off: new email via A -> account created; via B -> registration_disabled; site registration_enabled=false doesn't affect A", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B, autoCreateEnabled: false }] });
    await t.db.update(siteSettings).set({ registrationEnabled: false });
    const ra = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "na", email: "na@x.example" } });
    expect(ra.callbackRes.headers.location).toBe("/");
    expect(await t.db.select().from(users)).toHaveLength(1);
    const rb = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "nb", email: "nb@x.example" } });
    expect(rb.callbackRes.headers.location).toBe("/login?error=registration_disabled");
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("service config_version changed after callback verified the version and before the transaction -> /login?error=oidc_unavailable, no account, warn logged", async () => {
    const t = await appWithTokenHook();
    const providerId = t.provider.id;
    t.setBeforeToken(async () => {
      await t.db.update(authProviders).set({ configVersion: t.provider.configVersion + 1 }).where(eq(authProviders.id, providerId));
    });
    const r = await ssoRoundTrip(t.app, t.idp, { loginUrl: `/api/auth/oidc/login/${providerId}`, claims: { sub: "n", email: "n@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=oidc_unavailable");
    expect(await t.db.select().from(users)).toHaveLength(0);
    expect(t.logs.lines.filter(l => l.msg === STALE_MSG)).toEqual([{ msg: STALE_MSG, level: "warn", obj: { providerId } }]);
  });

  it("service row deleted after callback verified the version and before the transaction -> /login?error=oidc_unavailable, no account, warn logged", async () => {
    const t = await appWithTokenHook();
    const providerId = t.provider.id;
    t.setBeforeToken(async () => {
      await t.db.delete(authProviders).where(eq(authProviders.id, providerId));
    });
    const r = await ssoRoundTrip(t.app, t.idp, { loginUrl: `/api/auth/oidc/login/${providerId}`, claims: { sub: "n", email: "n@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=oidc_unavailable");
    expect(await t.db.select().from(users)).toHaveLength(0);
    expect(t.logs.lines.filter(l => l.msg === STALE_MSG)).toEqual([{ msg: STALE_MSG, level: "warn", obj: { providerId } }]);
  });

  it("contrast: before the transaction only auto-create flipped from off to on (version unchanged) -> account created as usual, no stale warn", async () => {
    const t = await appWithTokenHook({ autoCreateEnabled: false });
    const providerId = t.provider.id;
    t.setBeforeToken(async () => {
      await t.db.update(authProviders).set({ autoCreateEnabled: true }).where(eq(authProviders.id, providerId));
    });
    const r = await ssoRoundTrip(t.app, t.idp, { loginUrl: `/api/auth/oidc/login/${providerId}`, claims: { sub: "n", email: "n@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect(t.logs.lines.filter(l => l.msg === STALE_MSG)).toEqual([]);
  });

  it("with next: version changed before the transaction -> /login?error=oidc_unavailable&next=...", async () => {
    const t = await appWithTokenHook();
    const providerId = t.provider.id;
    t.setBeforeToken(async () => {
      await t.db.update(authProviders).set({ configVersion: t.provider.configVersion + 1 }).where(eq(authProviders.id, providerId));
    });
    const r = await ssoRoundTrip(t.app, t.idp, { loginUrl: `/api/auth/oidc/login/${providerId}?next=%2Fn%2Falice%2Fx`, claims: { sub: "n", email: "n@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=oidc_unavailable&next=%2Fn%2Falice%2Fx");
    expect(await t.db.select().from(users)).toHaveLength(0);
  });

  it("claim limits: email of 255 chars or sub of 256 -> oidc_claim_too_long, pending not sealed, no account; exactly 254/255 -> as usual", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const email255 = "e".repeat(255 - "@x.example".length) + "@x.example";
    const email254 = "e".repeat(254 - "@x.example".length) + "@x.example";
    for (const claims of [{ sub: "s1", email: email255 }, { sub: "s".repeat(256), email: "ok@x.example" }]) {
      const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims });
      expect(r.callbackRes.headers.location).toBe("/login?error=oidc_claim_too_long");
      expect(r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    }
    expect(await t.db.select().from(users)).toHaveLength(0);
    const ok = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "s".repeat(255), email: email254 } });
    expect(ok.callbackRes.headers.location).toBe("/");
  });

  it("provider id uppercase in the login and callback URLs -> completes as usual; the redirect_uri sent to the IdP uses the lowercase id", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const r = await ssoRoundTrip(t.app, t.idp("a"), {
      loginUrl: `/api/auth/oidc/login/${id.toUpperCase()}`, claims: { sub: "sa", email: "a@x.example" },
      callbackPath: `/api/auth/oidc/callback/${id.toUpperCase()}`,
    });
    expect(r.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${id}`);
    expect(r.callbackRes.headers.location).toBe("/");
    expect(r.cookies[SESSION_COOKIE]).toBeDefined();
  });

  it("two enabled providers pointing at the same issuer -> an account created via A logs in directly via B (not confirm_link, no second account)", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a1", issuerUrl: A, clientId: "c1" }, { key: "a2", issuerUrl: `${A}/`, clientId: "c2", displayName: "Same IdP again" }] });
    await ssoRoundTrip(t.app, t.idp("a1"), { loginUrl: `/api/auth/oidc/login/${t.provider("a1").id}`, claims: { sub: "sa", email: "a@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("a2"), { loginUrl: `/api/auth/oidc/login/${t.provider("a2").id}`, claims: { sub: "sa", email: "a@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(r.cookies[SESSION_COOKIE]).toBeDefined();
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("trailing-slash form: provider is https://gitlab.example/, IdP returns without the slash -> login succeeds, resolved_issuer written without the slash, identity stores the IdP's value", async () => {
    const t = await buildOidcApp({ providers: [{ key: "g", issuerUrl: "https://gitlab.example/", idpIssuer: "https://gitlab.example" }] });
    const r = await ssoRoundTrip(t.app, t.idp("g"), { loginUrl: `/api/auth/oidc/login/${t.provider("g").id}`, claims: { sub: "sg", email: "g@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    const [p] = await t.db.select({ r: authProviders.resolvedIssuer }).from(authProviders);
    expect(p!.r).toBe("https://gitlab.example");
    const [i] = await t.db.select({ issuer: userIdentities.issuer }).from(userIdentities);
    expect(i!.issuer).toBe("https://gitlab.example");
  });

  it("legacy provider on the old callback URL, with identities moved by 0014 and one registered later -> logs into the same account", async () => {
    const idp = createFakeIdp(A);
    const { app, db } = await buildTestApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: idp.fetch }) });
    const [u] = await db.insert(users).values({ email: "legacy@x.example", displayName: "Legacy" }).returning();
    const [v] = await db.insert(users).values({ email: "rolled@x.example", displayName: "Rolled" }).returning();
    await db.insert(userIdentities).values({ userId: u!.id, issuer: A, sub: "migrated" });
    await db.$client.query(`update users set oidc_issuer = $1, oidc_sub = 'rolled-back' where id = $2`, [A, v!.id]);
    await seedAuthProvider(db, { issuerUrl: `${A}/`, legacyCallback: true, displayName: "SSO" });
    await backfillLegacyOidcIdentities(db, silent);
    for (const [sub, email, userId] of [["migrated", "legacy@x.example", u!.id], ["rolled-back", "rolled@x.example", v!.id]] as const) {
      const r = await ssoRoundTrip(app, idp, { loginUrl: "/api/auth/oidc/login", claims: { sub, email } });
      expect(r.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
      expect(r.callbackRes.headers.location).toBe("/");
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: r.cookies[SESSION_COOKIE]! } });
      expect(me.json().id).toBe(userId);
    }
    const [p] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders);
    expect(p!.r).toBe(A);
  });

  it("email_verified false, the string 'true', or missing -> same result as true (account created as usual)", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const variants: Array<Record<string, unknown>> = [{ email_verified: false }, { email_verified: "true" }, {}];
    for (const [i, extra] of variants.entries()) {
      const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: `b3-${i}`, email: `b3-${i}@x.example`, ...extra } as never });
      expect(r.callbackRes.headers.location).toBe("/");
    }
    expect(await t.db.select().from(users)).toHaveLength(3);
  });

  it("oidc_link_no_proof_method: SSO-only account whose linked provider is disabled -> another provider's first login with the same email returns that code (pending not sealed)", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "p@x.example" } });
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "p@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=oidc_link_no_proof_method");
    expect(r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
  });
});
