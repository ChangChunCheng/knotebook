import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, ssoRoundTrip, type OidcTestApp } from "./helpers/oidc-provider.js";
import { GENERIC } from "./helpers/provider-icon.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { unsealOidcState } from "../src/auth/oidc-state.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";
import type { FakeIdpClaims } from "./helpers/fake-idp.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const nowS = () => Math.floor(Date.now() / 1000);
const lastLoginOf = async (db: Db, id: string) =>
  (await db.execute<{ t: string | null }>(sql`select last_login_at::text as t from users where id = ${id}`)).rows[0]!.t;

/** SSO-only account U (identity at A) + B first login with the same email -> pending. */
async function ssoOnlyPending(t: OidcTestApp, next?: string) {
  await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "ua", email: "u@x.example" } });
  const [u] = await t.db.select().from(users).where(eq(users.email, "u@x.example"));
  const q = next !== undefined ? `?next=${encodeURIComponent(next)}` : "";
  const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}${q}`, claims: { sub: "ub", email: "u@x.example" } });
  const pending = r.cookies[OIDC_PENDING_COOKIE]!;
  return { user: u!, pending, pendingId: unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId };
}

async function prove(t: OidcTestApp, key: string, cookies: Record<string, string>, pendingId: string, claims: FakeIdpClaims) {
  const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider(key).id}`, cookies, payload: { pendingId } });
  if (start.statusCode !== 200) return { start, callback: undefined };
  t.idp(key).setNextLogin(claims);
  const { code, state } = t.idp(key).authorize(start.json().url);
  const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  const callback = await t.app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback/${t.provider(key).id}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { ...cookies, [OIDC_STATE_COOKIE]: stateCookie },
  });
  return { start, callback };
}

const app2 = (over = {}) => buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] }, over);

describe("SSO proof (#187)", () => {
  it("SSO-only account: methods={password:false, providers:[A]}; proving with A -> B's identity (from pending) is linked to U, session signed, flag not cleared, pending cleared, A's last_login_at updated", async () => {
    const t = await app2();
    const { user, pending, pendingId } = await ssoOnlyPending(t, "/n/alice/x");
    await t.db.execute(sql`update users set last_login_at = null where id = ${user.id}`);
    await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: false, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const { start, callback } = await prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "whatever@else.example" });
    expect(start.statusCode).toBe(200);
    expect(new URL(start.json().url).origin).toBe(A);
    const st = unsealOidcState(testConfig.appSecret, start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value, nowS());
    expect(st).toMatchObject({ intent: "prove", providerId: t.provider("a").id, pendingId, proveUserId: user.id });
    expect(st && "next" in st).toBe(false);
    expect(callback!.headers.location).toBe("/n/alice/x");
    expect(callback!.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    expect(callback!.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
    const [row] = await t.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, user.id));
    expect(row!.m).toBe(true);
    const [proof] = await t.db.select().from(userIdentities).where(eq(userIdentities.sub, "ua"));
    expect(proof!.lastLoginAt).not.toBeNull();
    expect(await lastLoginOf(t.db, user.id)).not.toBeNull();
  });

  it("binding: the A login belongs to another account V's identity -> /link-account?error=oidc_link_proof_mismatch, nothing written, pending kept; afterwards a password still succeeds (account with a password and A's identity)", async () => {
    const t = await app2();
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: A, sub: "ua" });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "va", email: "v@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: true, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const { callback } = await prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "va", email: "v@x.example" });
    expect(callback!.headers.location).toBe("/link-account?error=oidc_link_proof_mismatch");
    expect(callback!.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "ua" }]);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { password: "correct-horse-battery-staple", pendingId } });
    expect(ok.statusCode).toBe(200);
  });

  it("state's pendingId doesn't match the current pending (another tab overwrote it) -> /link-account?error=oidc_link_expired (pending not cleared); pending already gone at callback -> same; start with no pending -> 401", async () => {
    const t = await app2();
    const first = await ssoOnlyPending(t);
    // The pending cookie is already gone at callback (expired or cleared: `readPendingLink` returns null either way): only the state cookie comes back.
    const s0 = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: first.pending }, payload: { pendingId: first.pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const a0 = t.idp("a").authorize(s0.json().url);
    const cb0 = await t.app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${a0.code}&state=${a0.state}`,
      cookies: { [OIDC_STATE_COOKIE]: s0.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value },
    });
    expect(cb0.headers.location).toBe("/link-account?error=oidc_link_expired");
    expect(await identitiesOf(t.db, first.user.id)).toEqual([{ issuer: A, sub: "ua" }]);
    // Another tab overwrote the pending.
    const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: first.pending }, payload: { pendingId: first.pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const { code, state } = t.idp("a").authorize(start.json().url);
    const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    // Running B again in another tab of the same browser overwrites pending (new pendingId).
    const again = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const overwritten = again.cookies[OIDC_PENDING_COOKIE]!;
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: overwritten, [OIDC_STATE_COOKIE]: stateCookie } });
    expect(cb.headers.location).toBe("/link-account?error=oidc_link_expired");
    // On mismatch don't clear the cookie: the new pending after overwriting belongs to the other tab and is still valid.
    expect(cb.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    const stillThere = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: overwritten } });
    expect(stillThere.statusCode).toBe(200);
    const second = await prove(t, "a", { [OIDC_PENDING_COOKIE]: overwritten }, unsealPendingLink(testConfig.appSecret, overwritten, nowS())!.pendingId, { sub: "ua", email: "u@x.example" });
    expect(second.callback!.statusCode).toBe(302);
    const noPending = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, payload: { pendingId: "x" } });
    expect(noPending.statusCode).toBe(401);
  });

  it("start: provider not linked / disabled / not a uuid -> 404 provider_not_found (indistinguishable); pendingId mismatch -> 409; no body -> 400; form -> 415", async () => {
    const t = await app2();
    const { pending, pendingId } = await ssoOnlyPending(t);
    const post = (id: string, payload?: unknown, headers?: Record<string, string>) =>
      t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, ...(payload !== undefined ? { payload: payload as object } : {}), ...(headers ? { headers } : {}) });
    for (const id of [t.provider("b").id, "not-a-uuid"]) {
      const r = await post(id, { pendingId });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("provider_not_found");
    }
    expect((await post(t.provider("a").id, { pendingId: "other" })).json().error.code).toBe("oidc_link_expired");
    expect((await post(t.provider("a").id)).statusCode).toBe(400);
    const form = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `pendingId=${pendingId}` });
    expect(form.statusCode).toBe(415);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    expect((await post(t.provider("a").id, { pendingId })).statusCode).toBe(404);
  });

  it("account already has another sub of the pending issuer (B) -> start for B returns 404 provider_not_found (the same exclusion as GET pending), A is still usable", async () => {
    const t = await app2();
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values([{ userId: u.id, issuer: A, sub: "ua" }, { userId: u.id, issuer: B, sub: "older-b" }]);
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: true, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const post = (key: string) => t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider(key).id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    const viaB = await post("b");
    expect(viaB.statusCode).toBe(404);
    expect(viaB.json().error.code).toBe("provider_not_found");
    expect(viaB.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
    expect((await post("a")).statusCode).toBe(200);
  });

  it("account has A(sub-1) + B -> first login with another sub of A doesn't reveal before proof that the same issuer was linked; after proving with B -> /link-account?error=identity_already_linked, nothing written", async () => {
    const t = await app2();
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sub-1", email: "u@x.example" } });
    const [u] = await t.db.select().from(users).where(eq(users.email, "u@x.example"));
    await t.db.insert(userIdentities).values({ userId: u!.id, issuer: B, sub: "ub" });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sub-2", email: "u@x.example" } });
    // Before proof: callback only redirects to /link-account and GET pending lists only B (A is excluded as the same issuer): neither reveals "another sub of A already exists".
    expect(r.callbackRes.headers.location).toBe("/link-account");
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.statusCode).toBe(200);
    expect(get.json().methods).toEqual({ password: false, providers: [{ id: t.provider("b").id, displayName: "B", icon: GENERIC }] });
    expect(JSON.stringify(get.json())).not.toContain("identity_already_linked");
    const { start, callback } = await prove(t, "b", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ub", email: "u@x.example" });
    expect(start.statusCode).toBe(200);
    expect(callback!.headers.location).toBe("/link-account?error=identity_already_linked");
    expect(callback!.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sub-1" }, { issuer: B, sub: "ub" }]);
    expect(await t.db.select().from(userIdentities).where(eq(userIdentities.sub, "sub-2"))).toEqual([]);
  });

  it("the proof provider disabled during the round trip -> callback 302 /login?error=oidc_unavailable; identity deleted -> oidc_link_proof_mismatch", async () => {
    const t = await app2();
    const { user, pending, pendingId } = await ssoOnlyPending(t);
    const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const { code, state } = t.idp("a").authorize(start.json().url);
    const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: stateCookie } });
    expect(cb.headers.location).toBe("/login?error=oidc_unavailable");
    await t.db.update(authProviders).set({ enabled: true }).where(eq(authProviders.id, t.provider("a").id));
    const start2 = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const auth2 = t.idp("a").authorize(start2.json().url);
    await t.db.delete(userIdentities).where(eq(userIdentities.userId, user.id));
    const cb2 = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${auth2.code}&state=${auth2.state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: start2.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value } });
    expect(cb2.headers.location).toBe("/link-account?error=oidc_link_proof_mismatch");
  });

  it("target account disabled during the round trip -> /link-account?error=account_disabled; email changed -> oidc_link_expired (pending cleared)", async () => {
    for (const [mutate, code] of [[{ disabledAt: new Date() }, "account_disabled"], [{ email: "changed@x.example" }, "oidc_link_expired"]] as const) {
      const t = await app2();
      const { user, pending, pendingId } = await ssoOnlyPending(t);
      const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
      t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
      const { code: c, state } = t.idp("a").authorize(start.json().url);
      await t.db.update(users).set(mutate).where(eq(users.id, user.id));
      const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${c}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: start.cookies.find(x => x.name === OIDC_STATE_COOKIE)!.value } });
      expect(cb.headers.location).toBe(`/link-account?error=${code}`);
      expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }]);
    }
  });

  it("password proof and SSO proof complete at the same time (the same pending) -> the latecomer sees after the users lock that the identity already belongs to the user and succeeds idempotently; both sessions are valid", async () => {
    const gate = { release: () => {}, entered: () => {} };
    const held = new Promise<void>(r => (gate.release = r));
    const entered = new Promise<void>(r => (gate.entered = r));
    let first = true;
    const hook: OidcTestHook = async point => {
      if (point === "link-locked" && first) {
        first = false;
        gate.entered();
        await held;
      }
    };
    const t = await app2({ oidcTestHook: hook });
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: A, sub: "ua" });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const confirmP = t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { password: "correct-horse-battery-staple", pendingId } });
    await entered;
    const proveP = prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "u@x.example" });
    try {
      expect(await waitForBlockedOrSettled(t.db.$client, proveP)).toBe("blocked");
    } finally {
      gate.release();
    }
    const [c, p] = await Promise.all([confirmP, proveP]);
    expect(c.statusCode).toBe(200);
    expect(p.callback!.headers.location).toBe("/");
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
    for (const cookie of [c.cookies, p.callback!.cookies].map(cs => cs.find(x => x.name === SESSION_COOKIE)!.value)) {
      expect((await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } })).json().id).toBe(u.id);
    }
  });

  it("while the SSO proof holds the users row lock, an SSO login of the same account (touching only user_identities) isn't blocked and completes, last_login_at is skipped by SKIP LOCKED; after release the proof succeeds and is recorded, no 40P01", async () => {
    const gate = { release: () => {}, entered: () => {} };
    const held = new Promise<void>(r => (gate.release = r));
    const entered = new Promise<void>(r => (gate.entered = r));
    let first = true;
    const hook: OidcTestHook = async point => {
      if (point === "link-locked" && first) {
        first = false;
        gate.entered();
        await held;
      }
    };
    const t = await app2({ oidcTestHook: hook });
    const { user, pending, pendingId } = await ssoOnlyPending(t);
    await t.db.execute(sql`update users set last_login_at = null where id = ${user.id}`); // clears the value ssoOnlyPending's first login recorded
    const proveP = prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "u@x.example" });
    await entered;
    const loginP = ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "ua", email: "u@x.example" } });
    try {
      // This case proves "not blocked": the login branch doesn't write users, so it doesn't intersect the SSO proof's users lock; the
      // post-transaction touchLastLogin takes the row with SKIP LOCKED, so while the SSO proof holds the lock the whole statement hits 0 rows and doesn't wait (#247).
      expect(await waitForBlockedOrSettled(t.db.$client, loginP)).toBe("settled");
      expect((await loginP).callbackRes.headers.location).toBe("/");
      expect(await lastLoginOf(t.db, user.id)).toBeNull();
    } finally {
      gate.release();
    }
    const [p, l] = await Promise.all([proveP, loginP]);
    expect(l.callbackRes.headers.location).toBe("/");
    expect(p.callback!.headers.location).toBe("/");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
    expect(await lastLoginOf(t.db, user.id)).not.toBeNull(); // recorded once the SSO proof commits
  });
});
