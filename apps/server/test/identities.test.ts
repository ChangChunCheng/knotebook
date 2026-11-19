import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, userIdentities, users } from "../src/db/schema.js";
import { backfillLegacyOidcIdentities } from "../src/auth/legacy-identities.js";
import { buildTestApp, insertPasswordUser, testConfig, type TestApp } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { GENERIC } from "./helpers/provider-icon.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";

async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}
async function identity(db: TestApp["db"], userId: string, issuer: string, sub: string): Promise<string> {
  const [row] = await db.insert(userIdentities).values({ userId, issuer, sub }).returning({ id: userIdentities.id });
  return row!.id;
}
const getIds = (app: TestApp["app"], cookies: Record<string, string>) => app.inject({ method: "GET", url: "/api/auth/identities", cookies });
const unlink = (app: TestApp["app"], cookies: Record<string, string>, id: string) =>
  app.inject({ method: "DELETE", url: `/api/auth/identities/${id}`, cookies });

describe("GET /api/auth/identities (#187)", () => {
  it("returns identities (providers, unlinkable, no sub), linkable, hasPassword and the effective passwordLoginEnabled", async () => {
    const { app, db } = await buildTestApp();
    const pa = await seedAuthProvider(db, { issuerUrl: A, displayName: "A", template: "gitlab" });
    const pb = await seedAuthProvider(db, { issuerUrl: B, displayName: "B", template: "google" });
    await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false, clientSecret: null });
    const u = await insertPasswordUser(db);
    const idA = await identity(db, u.id, A, "sa");
    const res = await getIds(app, await cookieOf(u.id));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identities).toEqual([
      { id: idA, issuer: A, providers: [{ id: pa.id, displayName: "A", icon: { type: "builtin", name: "gitlab" } }], createdAt: expect.any(String), lastLoginAt: null, unlinkable: true },
    ]);
    expect(JSON.stringify(body)).not.toContain("sa");
    expect(body.linkable).toEqual([{ providerId: pb.id, displayName: "B", template: "google", icon: { type: "builtin", name: "google" } }]);
    expect(body).toMatchObject({ hasPassword: true, passwordLoginEnabled: true });
  });

  it("Bearer (PAT) -> 401; not logged in -> 401", async () => {
    const { app, db } = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/auth/identities" })).statusCode).toBe(401);
    // Valid PAT (scope enough for authenticateAny) with no cookie: the 401 can only come from the endpoint accepting sessions only.
    const { token } = await seedTokenForUser(db, (await seedUser(db)).id);
    expect((await app.inject({ method: "GET", url: "/api/auth/identities", headers: bearer(token) })).statusCode).toBe(401);
  });

  it("trailing-slash shape: provider is `https://a.example/`, identity has no slash - resolved_issuer is wrong before being written and right after", async () => {
    const { app, db } = await buildTestApp();
    const p = await seedAuthProvider(db, { issuerUrl: `${A}/`, displayName: "A" });
    const u = await seedUser(db);
    await identity(db, u.id, A, "sa");
    const before = (await getIds(app, await cookieOf(u.id))).json();
    expect(before.identities[0].providers).toEqual([]);
    expect(before.linkable.map((l: { providerId: string }) => l.providerId)).toEqual([p.id]);
    await db.execute(sql`update auth_providers set resolved_issuer = ${A} where id = ${p.id}`);
    const after = (await getIds(app, await cookieOf(u.id))).json();
    expect(after.identities[0].providers).toEqual([{ id: p.id, displayName: "A", icon: GENERIC }]);
    expect(after.linkable).toEqual([]);
  });

  it("passwordLoginEnabled is the effective value: DB off -> false; env force + DB off -> true", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await getIds(app, await cookieOf(u.id))).json().passwordLoginEnabled).toBe(false);
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const v = await insertPasswordUser(forced.db);
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await getIds(forced.app, await cookieOf(v.id))).json().passwordLoginEnabled).toBe(true);
  });
});

describe("unlinkable matches DELETE cell by cell (#187)", () => {
  const cells: Array<[boolean, boolean, "none" | "enabled" | "disabled", boolean]> = [];
  for (const hasPassword of [false, true]) {
    for (const dbValue of [true, false]) {
      for (const second of ["none", "enabled", "disabled"] as const) {
        const expected = (hasPassword && dbValue) || second === "enabled";
        cells.push([hasPassword, dbValue, second, expected]);
      }
    }
  }
  it.each(cells)("password=%s, DB=%s, second identity=%s -> unlinkable=%s and DELETE agrees", async (hasPassword, dbValue, second, expected) => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    if (second !== "none") {
      await seedAuthProvider(db, { issuerUrl: B, enabled: second === "enabled", ...(second === "disabled" ? { clientSecret: null } : {}) });
    }
    const u = hasPassword ? await insertPasswordUser(db) : await seedUser(db);
    const target = await identity(db, u.id, A, "sa");
    if (second !== "none") await identity(db, u.id, B, "sb");
    await db.update(siteSettings).set({ passwordLoginEnabled: dbValue });
    const cookies = await cookieOf(u.id);
    const row = (await getIds(app, cookies)).json().identities.find((i: { id: string }) => i.id === target);
    expect(row.unlinkable).toBe(expected);
    const res = await unlink(app, cookies, target);
    expect(res.statusCode).toBe(expected ? 204 : 409);
    if (!expected) expect(res.json().error.code).toBe("last_login_method");
  });

  it("env force + DB off, password + one identity -> still 409 (the unlink decision looks at the DB value, not env)", async () => {
    const { app, db } = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const cookies = await cookieOf(u.id);
    expect((await getIds(app, cookies)).json().identities[0].unlinkable).toBe(false);
    expect((await unlink(app, cookies, target)).json().error.code).toBe("last_login_method");
  });
});

describe("DELETE /api/auth/identities/:id (#187)", () => {
  it("not mine, missing, non-UUID -> 404 not_found; identity untouched", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const me = await insertPasswordUser(db);
    const other = await insertPasswordUser(db);
    const theirs = await identity(db, other.id, A, "so");
    const cookies = await cookieOf(me.id);
    for (const id of [theirs, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await unlink(app, cookies, id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    expect(await identitiesOf(db, other.id)).toEqual([{ issuer: A, sub: "so" }]);
  });

  it("uppercase path id behaves like lowercase (204, identity deleted)", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    expect((await unlink(app, await cookieOf(u.id), target.toUpperCase())).statusCode).toBe(204);
    expect(await identitiesOf(db, u.id)).toEqual([]);
  });

  it("the same transaction clears a matching users.oidc_*; a later boot backfill doesn't resurrect it (a non-matching legacy column is left alone)", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    await db.execute(sql`update users set oidc_issuer = ${A}, oidc_sub = 'sa' where id = ${u.id}`);
    const v = await insertPasswordUser(db);
    const vTarget = await identity(db, v.id, A, "sv");
    await db.execute(sql`update users set oidc_issuer = ${A}, oidc_sub = 'other-sub' where id = ${v.id}`);

    expect((await unlink(app, await cookieOf(u.id), target)).statusCode).toBe(204);
    expect((await unlink(app, await cookieOf(v.id), vTarget)).statusCode).toBe(204);
    const [uRow] = await db.select({ i: users.oidcIssuer, s: users.oidcSub }).from(users).where(eq(users.id, u.id));
    expect(uRow).toEqual({ i: null, s: null });
    const [vRow] = await db.select({ i: users.oidcIssuer, s: users.oidcSub }).from(users).where(eq(users.id, v.id));
    expect(vRow).toEqual({ i: A, s: "other-sub" });

    const logger = { warn: () => {} } as unknown as Parameters<typeof backfillLegacyOidcIdentities>[1];
    await backfillLegacyOidcIdentities(db, logger);
    expect(await identitiesOf(db, u.id)).toEqual([]);
  });

  it("does not revoke sessions: after unlinking, the same cookie still gets 200 from /me", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    const cookies = await cookieOf(u.id);
    expect((await unlink(app, cookies, target)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
  });

  it("concurrent unlink of the last two identities by one user: another connection holds the users lock and has deleted X -> unlinking Y here waits for its commit -> 409 last_login_method", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    await seedAuthProvider(db, { issuerUrl: B });
    const u = await seedUser(db);
    const x = await identity(db, u.id, A, "sa");
    const y = await identity(db, u.id, B, "sb");
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [u.id]);
      await holder.query("delete from user_identities where id = $1", [x]);
      const pending = unlink(app, await cookieOf(u.id), y);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("last_login_method");
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  // This test doesn't exercise the anti-lockout second check (the holder lays out the unlink transaction's lock footprint with hand-written SQL): it only guards
  // that a login whose update affects 0 rows still signs a session. Real concurrency of unlink and login is in the next test.
  it("login hitting an identity deleted by an uncommitted unlink -> waits for its commit, still signs the session with 0 rows affected", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const u = await insertPasswordUser(t.db);
    const idA = await identity(t.db, u.id, A, "sa");
    const holder = await holderFor(t.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [u.id]);
      await holder.query("select password_login_enabled from site_settings where singleton for share");
      await holder.query("delete from user_identities where id = $1", [idA]);
      const pending = ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: u.email } });
      expect(await waitForBlockedOrSettled(t.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const r = await pending;
      expect(r.callbackRes.headers.location).toBe("/");
      expect(r.cookies[SESSION_COOKIE]).toBeTruthy();
    } finally {
      await holder.end();
    }
  });

  it("a real unlink holds the users lock and is blocked on the identity row -> a real SSO login (another identity of the same account) doesn't wait on users and completes; after release the unlink -> 204 with no 40P01", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    const u = await insertPasswordUser(t.db);
    const idA = await identity(t.db, u.id, A, "sa");
    await identity(t.db, u.id, B, "sb");
    const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"timeout">(r => setTimeout(() => r("timeout"), ms))]);
    const holder = await holderFor(t.db);
    try {
      // holder = the lock footprint of a login of A in progress (login branch: site_settings FOR SHARE + UPDATE of that identity row, uncommitted).
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for share");
      await holder.query("update user_identities set last_login_at = now() where id = $1", [idA]);
      const del = unlink(t.app, await cookieOf(u.id), idA);
      // The real unlink already holds users NKU + site_settings SHARE and is blocked deleting A's row.
      expect(await waitForBlockedOrSettled(t.db.$client, del)).toBe("blocked");
      const login = ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: u.email } });
      const r = await within(login, 5000);
      expect(r).not.toBe("timeout");
      if (r !== "timeout") {
        expect(r.callbackRes.headers.location).toBe("/");
        expect(r.cookies[SESSION_COOKIE]).toBeTruthy();
      }
      await holder.query("commit");
      expect((await del).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });
});
