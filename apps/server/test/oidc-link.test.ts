import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { userIdentities, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { freshLimiters, insertPasswordUser } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, type OidcTestApp } from "./helpers/oidc-provider.js";
import type { FakeIdpClaims } from "./helpers/fake-idp.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const lastLoginOf = async (db: Db, id: string) =>
  (await db.execute<{ t: string | null }>(sql`select last_login_at::text as t from users where id = ${id}`)).rows[0]!.t;
const twoProviders = (overrides = {}) =>
  buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] }, overrides);

async function holderFor(db: OidcTestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}

const start = (t: OidcTestApp, cookies: Record<string, string>, providerId: string, payload: unknown = {}) =>
  t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${providerId}`, cookies, ...(payload === undefined ? {} : { payload: payload as object }) });

/** Start -> fake IdP -> callback. `callbackCookies` can replace the session sent at callback (for the session-mismatch cases). */
async function linkRoundTrip(
  t: OidcTestApp,
  key: string,
  cookies: Record<string, string>,
  claims: FakeIdpClaims,
  opts: { providerIdInPath?: string; callbackCookies?: Record<string, string>; beforeCallback?: () => Promise<void> } = {},
) {
  t.idp(key).setNextLogin(claims);
  const startRes = await start(t, cookies, opts.providerIdInPath ?? t.provider(key).id);
  expect(startRes.statusCode, startRes.body).toBe(200);
  const url: string = startRes.json().url;
  const { code, state } = t.idp(key).authorize(url);
  const callbackPath = new URL(new URL(url).searchParams.get("redirect_uri")!).pathname;
  const stateCookie = startRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  if (opts.beforeCallback !== undefined) await opts.beforeCallback();
  const callback = t.app.inject({
    method: "GET",
    url: `${callbackPath}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { ...(opts.callbackCookies ?? cookies), [OIDC_STATE_COOKIE]: stateCookie },
  });
  return { startRes, callback };
}

describe("POST /api/auth/oidc/link/:providerId (#187)", () => {
  it("200 {url}, state cookie sealed; the URL is that provider's authorization endpoint", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const res = await start(t, await cookieOf(u.id), t.provider("b").id);
    expect(res.statusCode).toBe(200);
    expect(new URL(res.json().url).origin).toBe(B);
    expect(res.cookies.find(c => c.name === OIDC_STATE_COOKIE)?.value).toBeTruthy();
  });

  it("no body -> 400; form shape -> 415 (CSRF hook); JSON with extra fields -> 400", async () => {
    const t = await twoProviders();
    const cookies = await cookieOf((await insertPasswordUser(t.db)).id);
    const id = t.provider("b").id;
    expect((await t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${id}`, cookies })).statusCode).toBe(400);
    const form = await t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${id}`, cookies, payload: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.statusCode).toBe(415);
    expect((await start(t, cookies, id, { x: 1 })).statusCode).toBe(400);
  });

  it("session-only: logged out / Bearer -> 401; must_change_password -> 403 forbidden (blocked before the limiter)", async () => {
    const t = await twoProviders({ limiters: freshLimiters({ oidcLogin: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const id = t.provider("b").id;
    expect((await t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${id}`, payload: {} })).statusCode).toBe(401);
    // Valid PAT (scope sufficient for authenticateAny), no cookie: the 401 can only come from "only accepts a session".
    const { token } = await seedTokenForUser(t.db, (await insertPasswordUser(t.db)).id);
    expect((await t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${id}`, payload: {}, headers: bearer(token) })).statusCode).toBe(401);
    const flagged = await insertPasswordUser(t.db, { mustChangePassword: true });
    const res = await start(t, await cookieOf(flagged.id), id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    // The limiter quota of 1 is still there: the rejected request wasn't charged
    expect((await start(t, await cookieOf((await insertPasswordUser(t.db)).id), id)).statusCode).toBe(200);
  });

  it("provider nonexistent / disabled / not a UUID -> 404 provider_not_found", async () => {
    const t = await twoProviders();
    const cookies = await cookieOf((await insertPasswordUser(t.db)).id);
    await t.db.execute(sql`update auth_providers set enabled = false where id = ${t.provider("b").id}`);
    for (const id of [t.provider("b").id, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await start(t, cookies, id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error.code).toBe("provider_not_found");
    }
  });

  it("pre-check: the user already has an identity whose issuer = its effective issuer -> 409 identity_already_linked", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: B, sub: "old" });
    const res = await start(t, await cookieOf(u.id), t.provider("b").id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("identity_already_linked");
  });

  it("trailing-slash form: provider is `B/`, resolved_issuer = B -> pre-check matches the slash-less identity -> 409; resolved not written -> pre-check can't match -> 200 (the authoritative decision is at callback)", async () => {
    const resolved = await buildOidcApp({ providers: [{ key: "b", issuerUrl: `${B}/`, resolvedIssuer: B }] });
    const u = await insertPasswordUser(resolved.db);
    await resolved.db.insert(userIdentities).values({ userId: u.id, issuer: B, sub: "old" });
    expect((await start(resolved, await cookieOf(u.id), resolved.provider("b").id)).json().error.code).toBe("identity_already_linked");
    const unresolved = await buildOidcApp({ providers: [{ key: "b", issuerUrl: `${B}/` }] });
    const v = await insertPasswordUser(unresolved.db);
    await unresolved.db.insert(userIdentities).values({ userId: v.id, issuer: B, sub: "old" });
    expect((await start(unresolved, await cookieOf(v.id), unresolved.provider("b").id)).statusCode).toBe(200);
  });

  it("limiter uses the oidcLogin bucket: quota used up -> 429", async () => {
    const t = await twoProviders({ limiters: freshLimiters({ oidcLogin: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const cookies = await cookieOf((await insertPasswordUser(t.db)).id);
    expect((await start(t, cookies, t.provider("b").id)).statusCode).toBe(200);
    expect((await start(t, cookies, t.provider("b").id)).json().error.code).toBe("too_many_requests");
  });

  it("discovery failure -> 503 oidc_unavailable", async () => {
    const t = await twoProviders();
    const cookies = await cookieOf((await insertPasswordUser(t.db)).id);
    t.idp("b").failNext("discovery");
    const res = await start(t, cookies, t.provider("b").id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("oidc_unavailable");
  });
});

describe("callback intent link branch (#187)", () => {
  it("success -> 302 /settings/login?linked=<id>, identity written (last_login_at set); doesn't require the same email; no new session", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "sb", email: "totally-different@elsewhere.example" });
    const res = await callback;
    expect(res.headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: B, sub: "sb" }]);
    const [row] = await t.db.select({ at: userIdentities.lastLoginAt }).from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(row!.at).not.toBeNull();
    expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await lastLoginOf(t.db, u.id)).toBeNull(); // linking a second identity while logged in: no session signed, users.last_login_at not written
  });

  it("provider id in the start path is uppercase -> links as usual (state binds the lowercase id, callback doesn't hit oidc_state_mismatch)", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "sb" }, { providerIdInPath: t.provider("b").id.toUpperCase() });
    expect((await callback).headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);
  });

  it("session mismatch -> ?link_error=oidc_link_session_mismatch: no session, someone else's session", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const v = await insertPasswordUser(t.db);
    for (const callbackCookies of [{}, await cookieOf(v.id)]) {
      const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: `sb-${Math.random()}` }, { callbackCookies });
      expect((await callback).headers.location).toBe("/settings/login?link_error=oidc_link_session_mismatch");
    }
    expect(await identitiesOf(t.db, u.id)).toEqual([]);
  });

  it("disabled after the start: the session check passes on the gate's 60 s cache, the re-check under lock stops it -> ?link_error=account_disabled, nothing written", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "sb-disabled" }, {
      beforeCallback: async () => { await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id)); },
    });
    expect((await callback).headers.location).toBe("/settings/login?link_error=account_disabled");
    expect(await identitiesOf(t.db, u.id)).toEqual([]);
  });

  it("identity belongs to someone else -> 302 location is exactly /settings/login?link_error=identity_taken; already the caller's -> idempotent linked; the same issuer already has another sub -> identity_already_linked", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const other = await insertPasswordUser(t.db);
    await t.db.insert(userIdentities).values({ userId: other.id, issuer: B, sub: "theirs" });
    const taken = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "theirs" });
    expect((await taken.callback).headers.location).toBe("/settings/login?link_error=identity_taken");

    const mine = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "mine" }, {
      beforeCallback: async () => { await t.db.insert(userIdentities).values({ userId: u.id, issuer: B, sub: "mine" }); },
    });
    expect((await mine.callback).headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);

    const w = await insertPasswordUser(t.db);
    const b2 = await linkRoundTrip(t, "b", await cookieOf(w.id), { sub: "second" }, {
      beforeCallback: async () => { await t.db.insert(userIdentities).values({ userId: w.id, issuer: B, sub: "first" }); },
    });
    expect((await b2.callback).headers.location).toBe("/settings/login?link_error=identity_already_linked");
    expect(await identitiesOf(t.db, w.id)).toEqual([{ issuer: B, sub: "first" }]);
  });

  it("failures before the cookie is unsealed still land on /login?error=: no state cookie -> oidc_state_mismatch", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const cookies = await cookieOf(u.id);
    t.idp("b").setNextLogin({ sub: "sb" });
    const startRes = await start(t, cookies, t.provider("b").id);
    const { code, state } = t.idp("b").authorize(startRes.json().url);
    const res = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("b").id}?code=${code}&state=${state}`, cookies });
    expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
  });

  it("someone else's first login (uncommitted) is creating the same (issuer, sub) -> the linking side waits for its commit -> identity_taken", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const holder = await holderFor(t.db);
    try {
      const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "contested" }, {
        beforeCallback: async () => {
          await holder.query("begin");
          await holder.query("insert into users (id, email, display_name, handle) values (gen_random_uuid(), 'c11@x.example', 'C11', 'c11-holder')");
          await holder.query("insert into user_identities (user_id, issuer, sub) select id, $1, 'contested' from users where email = 'c11@x.example'", [B]);
        },
      });
      expect(await waitForBlockedOrSettled(t.db.$client, callback)).toBe("blocked");
      await holder.query("commit");
      expect((await callback).headers.location).toBe("/settings/login?link_error=identity_taken");
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(t.db, u.id)).toEqual([]);
  });

  it("(manual link form) another connection holds this user's users lock and writes another sub of the same issuer -> this side waits for its commit -> identity_already_linked", async () => {
    const t = await twoProviders();
    const u = await insertPasswordUser(t.db);
    const holder = await holderFor(t.db);
    try {
      const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "sub-2" }, {
        beforeCallback: async () => {
          await holder.query("begin");
          await holder.query("select 1 from users where id = $1 for no key update", [u.id]);
          await holder.query("insert into user_identities (user_id, issuer, sub) values ($1, $2, 'sub-1')", [u.id, B]);
        },
      });
      expect(await waitForBlockedOrSettled(t.db.$client, callback)).toBe("blocked");
      await holder.query("commit");
      expect((await callback).headers.location).toBe("/settings/login?link_error=identity_already_linked");
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: B, sub: "sub-1" }]);
  });

  it("a password-less SSO-only account can also link a second one from the settings page (the session is the proof)", async () => {
    const t = await twoProviders();
    const u = await seedUser(t.db);
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: A, sub: "sa" });
    const { callback } = await linkRoundTrip(t, "b", await cookieOf(u.id), { sub: "sb" });
    expect((await callback).headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "sa" }, { issuer: B, sub: "sb" }]);
  });
});
