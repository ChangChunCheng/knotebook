import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { insertPasswordUser, testConfig, signTestSession } from "./helpers.js";
import { buildOidcApp, identitiesOf, ssoRoundTrip, type OidcTestApp } from "./helpers/oidc-provider.js";
import { expectedIcon, expectNoIconBytes, GENERIC, seedIconMatrix } from "./helpers/provider-icon.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { OIDC_PENDING_COOKIE, sealPendingLink, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { hashPassword } from "../src/auth/password.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
import { HashBusyError, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(verifyPassword).mockClear());

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const PW = "correct-horse-battery-staple";
const lastLoginOf = async (db: Db, id: string) =>
  (await db.execute<{ t: string | null }>(sql`select last_login_at::text as t from users where id = ${id}`)).rows[0]!.t;

/**
 * Existing account (with password) + provider B first login with the same email -> stops at /link-account (asserted inside). Returns
 * the pending cookie and pendingId. `beforeSso` runs after account creation and before SSO (e.g. inserting a same-issuer identity for
 * the account first) so that "still /link-account before proof" is really tested.
 */
async function toPending(
  t: OidcTestApp,
  opts: { mustChangePassword?: boolean; next?: string; email?: string; beforeSso?: (userId: string) => Promise<void> } = {},
) {
  const email = opts.email ?? "target@x.example";
  const user = await insertPasswordUser(t.db, { email, password: PW, mustChangePassword: opts.mustChangePassword ?? false });
  if (opts.beforeSso !== undefined) await opts.beforeSso(user.id);
  const q = opts.next !== undefined ? `?next=${encodeURIComponent(opts.next)}` : "";
  const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}${q}`, claims: { sub: "sb", email } });
  expect(r.callbackRes.headers.location).toBe("/link-account");
  const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
  const pendingId = unsealPendingLink(testConfig.appSecret, cookie, Math.floor(Date.now() / 1000))!.pendingId;
  return { user, cookie, pendingId };
}
const twoProviders = () => buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] });
const confirm = (t: OidcTestApp, cookie: string, body: unknown, extraCookies: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie, ...extraCookies }, payload: body as object });

describe("GET /api/auth/oidc/pending (#187)", () => {
  it("200: pendingId/email/providerDisplayName/methods (recomputed every time); no cookie -> 401", async () => {
    const t = await twoProviders();
    const { cookie, pendingId } = await toPending(t);
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pendingId, email: "target@x.example", providerDisplayName: "B", methods: { password: true, providers: [] } });
    expect((await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending" })).statusCode).toBe(401);
  });

  it("SSO-only account: methods.providers lists linked, enabled ones; recomputed after the provider is disabled -> 409 oidc_link_no_proof_method", async () => {
    const t = await twoProviders();
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "sso@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "sso@x.example" } });
    const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
    const get = () => t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect((await get()).json().methods).toEqual({ password: false, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const res = await get();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("oidc_link_no_proof_method");
  });

  it("target account's email changed -> 409 oidc_link_expired and the cookie is cleared", async () => {
    const t = await twoProviders();
    const { user, cookie } = await toPending(t);
    await t.db.update(users).set({ email: "changed@x.example" }).where(eq(users.id, user.id));
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("oidc_link_expired");
    expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
  });

  it("two enabled providers pointing at the same issuer the account is linked to -> methods.providers lists both", async () => {
    const t = await buildOidcApp({ providers: [
      { key: "a1", issuerUrl: A, displayName: "A one", sortOrder: 1 }, { key: "a2", issuerUrl: `${A}/`, displayName: "A two", sortOrder: 2, resolvedIssuer: A },
      { key: "b", issuerUrl: B, displayName: "B" },
    ] });
    await ssoRoundTrip(t.app, t.idp("a1"), { loginUrl: `/api/auth/oidc/login/${t.provider("a1").id}`, claims: { sub: "sa", email: "x@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "x@x.example" } });
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: r.cookies[OIDC_PENDING_COOKIE]! } });
    expect(res.json().methods.providers).toEqual([{ id: t.provider("a1").id, displayName: "A one", icon: GENERIC }, { id: t.provider("a2").id, displayName: "A two", icon: GENERIC }]);
  });

  it("the account has another sub of the pending issuer + an identity from an enabled provider of another issuer + a password -> providers lists only the other issuer, not the pending issuer", async () => {
    const t = await twoProviders();
    // These identities exist before SSO: another sub of B (same issuer) and A's identity (another issuer). Listing B would tell the other side before proof that "this account already linked B".
    const { cookie, pendingId } = await toPending(t, {
      beforeSso: async userId => {
        await t.db.insert(userIdentities).values([{ userId, issuer: B, sub: "older-sub" }, { userId, issuer: A, sub: "sa" }]);
      },
    });
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pendingId, email: "target@x.example", providerDisplayName: "B", methods: { password: true, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] } });
  });

  it("provider-icon: each methods.providers entry carries a converted icon (three templates x five kinds, re-shaped through `toPublicProvider`); no image bytes", async () => {
    const t = await twoProviders();
    const matrix = await seedIconMatrix(t.db);
    const { cookie } = await toPending(t, {
      beforeSso: async userId => {
        await t.db.insert(userIdentities).values(matrix.map((c, i) => ({ userId, issuer: c.issuer, sub: `m${i}` })));
      },
    });
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().methods.providers).toEqual(matrix.map(c => ({ id: c.id, displayName: c.displayName, icon: expectedIcon(c) })));
    expectNoIconBytes(res.body);
  });
});

describe("POST /api/auth/oidc/pending/confirm (#187)", () => {
  it("correct password -> 200 {user, next:'/'}, session signed, pending cleared, second identity row written; B logs in directly afterwards", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    expect(await lastLoginOf(t.db, user.id)).toBeNull(); // stopping at /link-account (confirm_link) signs no session and writes nothing
    await t.db.insert(userIdentities).values({ userId: user.id, issuer: A, sub: "sa" });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(200);
    expect(await lastLoginOf(t.db, user.id)).not.toBeNull();
    expect(res.json()).toMatchObject({ user: { id: user.id, email: user.email, hasPassword: true, mustChangePassword: false }, next: "/" });
    expect(res.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "sa" }, { issuer: B, sub: "sb" }]);
    const again = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: user.email } });
    expect(again.callbackRes.headers.location).toBe("/");
  });

  it("account with the flag true linking by password keeps the flag true (also /api/auth/me); the response's next comes from pending and has passed safeNextPath", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t, { mustChangePassword: true, next: "/n/alice/x" });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.json()).toMatchObject({ user: { mustChangePassword: true }, next: "/n/alice/x" });
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: res.cookies.find(c => c.name === SESSION_COOKIE)!.value } });
    expect(me.json().mustChangePassword).toBe(true);
    const [row] = await t.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, user.id));
    expect(row!.m).toBe(true);
  });

  it("wrong password -> 401 invalid_credentials, nothing written; charges LoginThrottle (same email key): the 6th after 5 -> 429, and /api/auth/login with the same email is also 429", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    for (let i = 0; i < 5; i++) {
      const r = await confirm(t, cookie, { password: "wrong-password-xx", pendingId });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe("invalid_credentials");
    }
    const sixth = await confirm(t, cookie, { password: PW, pendingId });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(typeof sixth.json().retryAfterMs).toBe("number");
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: PW } });
    expect(login.statusCode).toBe(429);
    // The previous line can't tell the account track apart: the same source IP's IP track has the same threshold of 5 and blocks by itself.
    // With another source IP only the account track remains: only if confirm and /api/auth/login share the same email key does it 429; with different keys a correct password here would be 200.
    const loginOtherIp = await t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.9.8.6", payload: { email: user.email, password: PW } });
    expect(loginOtherIp.statusCode).toBe(429);
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("HashBusyError -> 429 server_busy", async () => {
    const t = await twoProviders();
    const { cookie, pendingId } = await toPending(t);
    vi.mocked(verifyPassword).mockRejectedValueOnce(new HashBusyError());
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("server_busy");
  });

  it("password is verified before disabled is judged: disabled + wrong password -> 401; disabled + right password -> 403 account_disabled", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await confirm(t, cookie, { password: "wrong-password-xx", pendingId })).statusCode).toBe(401);
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("account_disabled");
  });

  it("account already has another sub of the same issuer -> /link-account before proof, 409 identity_already_linked after proving with the password", async () => {
    const t = await twoProviders();
    // The identity must exist **before** SSO: the `/link-account` assertion inside toPending is then the one for "doesn't reveal before proof that the same issuer was linked".
    const { user, cookie, pendingId } = await toPending(t, {
      beforeSso: async userId => {
        await t.db.insert(userIdentities).values({ userId, issuer: B, sub: "older-sub" });
      },
    });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("identity_already_linked");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "older-sub" }]);
  });

  it("when the transaction rejects (403 disabled) neither recordSuccess nor recordFailure is recorded: the account track's failure count isn't cleared", async () => {
    // The account track starts blocking at the 5th failure (`auth/rate-limit.ts` evaluateRecord: failureCount < 5 doesn't block, after
    // 5 it's 2^(5-4)=2 s). Switch to another source IP for the last two steps: LoginThrottle's IP track isn't cleared by recordSuccess
    // (recordSuccess only deletes the account track), so from the same IP the 5th failure fills the IP track to 5 too -> 429 whether or
    // not the account track was cleared, which would hide the difference. With another IP only the account track decides.
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    for (let i = 0; i < 4; i++) {
      expect((await confirm(t, cookie, { password: "wrong-password-xx", pendingId })).statusCode).toBe(401);
    }
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(403);
    await t.db.update(users).set({ disabledAt: null }).where(eq(users.id, user.id));
    const fromOtherIp = (password: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", remoteAddress: "10.9.8.7", cookies: { [OIDC_PENDING_COOKIE]: cookie }, payload: { password, pendingId } });
    expect((await fromOtherIp("wrong-password-xx")).statusCode).toBe(401);
    // The account track now has 5 failures -> blocks. If the transaction failing also called recordSuccess, the 403 step would clear the account track -> only 1 failure left -> 200.
    const last = await fromOtherIp(PW);
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe("too_many_attempts");
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("cookie expired: pending past exp -> confirm 401 unauthorized, nothing written (the same path as \"no pending\")", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    const nowS = Math.floor(Date.now() / 1000);
    const payload = unsealPendingLink(testConfig.appSecret, cookie, nowS)!;
    const expired = sealPendingLink(testConfig.appSecret, { ...payload, exp: nowS - 1 });
    const res = await confirm(t, expired, { password: PW, pendingId });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect((await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: expired } })).statusCode).toBe(401);
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("pendingId doesn't match the cookie (overwritten by another tab) -> 409 oidc_link_expired; the same cookie submitted twice -> the second is idempotent 200", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    const bad = await confirm(t, cookie, { password: PW, pendingId: "not-the-same" });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("oidc_link_expired");
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  it("account email changed at confirm -> 409 oidc_link_expired, pending cleared; judged before the password is verified (no verification, no throttle)", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.update(users).set({ email: "changed@x.example" }).where(eq(users.id, user.id));
    // Send a wrong password 5 times: only if the route judges the account first (the loadTarget part of routes/oidc-pending.ts) is it 409; if it verified the password first, the first request would be 401.
    for (let i = 0; i < 5; i++) {
      const res = await confirm(t, cookie, { password: "wrong-password-xx", pendingId });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("oidc_link_expired");
      expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    }
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
    // No throttle: if the 5 above had recorded failures, the account track (and the same-IP track) would already be at 5 -> this one 429.
    await t.db.update(users).set({ email: user.email }).where(eq(users.id, user.id));
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  it("account deleted at confirm -> 409 oidc_link_expired, pending cleared, password not verified", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.delete(users).where(eq(users.id, user.id));
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("oidc_link_expired");
    expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
  });

  it("body: missing pendingId -> 400 invalid_body; form shape -> 415 (CSRF hook); no pending cookie -> 401", async () => {
    const t = await twoProviders();
    const { cookie } = await toPending(t);
    expect((await confirm(t, cookie, { password: PW })).statusCode).toBe(400);
    const form = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie }, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "password=x&pendingId=y" });
    expect(form.statusCode).toBe(415);
    const none = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", payload: { password: PW, pendingId: "x" } });
    expect(none.statusCode).toBe(401);
  });

  it("the user changes their password after it's verified and before the write -> 401 invalid_credentials, nothing written", async () => {
    const holder: { db?: OidcTestApp["db"] } = {};
    const hook: OidcTestHook = async point => {
      if (point === "pending-confirm-verified") {
        await holder.db!.update(users).set({ passwordHash: await hashPassword("a-brand-new-password") }).where(eq(users.email, "target@x.example"));
      }
    };
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] }, { oidcTestHook: hook });
    holder.db = t.db;
    const { user, cookie, pendingId } = await toPending(t);
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("provider to link deleted while pending -> GET's providerDisplayName is null; password proof can still link", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("b").id));
    await t.db.delete(authProviders).where(eq(authProviders.id, t.provider("b").id));
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(get.json().providerDisplayName).toBeNull();
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  it("browser already logged in as another account V -> after linking the response's session is the target account; V's old session unaffected", async () => {
    const t = await twoProviders();
    const v = await insertPasswordUser(t.db, { email: "v@x.example" });
    const vCookie = await signTestSession({ userId: v.id, tv: 0 });
    const { user, cookie, pendingId } = await toPending(t);
    const res = await confirm(t, cookie, { password: PW, pendingId }, { [SESSION_COOKIE]: vCookie });
    const newSession = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newSession } });
    expect(me.json().id).toBe(user.id);
    const meV = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: vCookie } });
    expect(meV.json().id).toBe(v.id);
  });
});

describe("POST /api/auth/oidc/pending/cancel", () => {
  it("204, clears the pending cookie (GET afterwards -> 401)", async () => {
    const t = await twoProviders();
    const { cookie } = await toPending(t);
    const res = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/cancel", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(cleared).toMatchObject({ value: "", path: "/api/auth/oidc" });
  });
});
