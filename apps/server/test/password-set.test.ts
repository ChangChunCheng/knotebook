import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, users } from "../src/db/schema.js";
import { buildTestApp, insertPasswordUser, testConfig, type TestApp, signTestSession } from "./helpers.js";
import { cookieOf, seedUser, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});
import { HashBusyError, hashPassword, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(hashPassword).mockClear());

const NEW_PW = "brand-new-password-123";
const setPw = (app: TestApp["app"], cookies: Record<string, string>, payload: object = { newPassword: NEW_PW }) =>
  app.inject({ method: "POST", url: "/api/auth/password/set", cookies, payload });

async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}

describe("POST /api/auth/password/set (#187)", () => {
  it("SSO-only user -> 204, token_version bumped, own new cookie valid, old cookie invalid; password login then works; onUserRevoked called once", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const u = await seedUser(db);
    const old = await cookieOf(u.id);
    const res = await setPw(app, old);
    expect(res.statusCode).toBe(204);
    const fresh = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: fresh } })).json()).toMatchObject({ hasPassword: true });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: old })).statusCode).toBe(401);
    const [row] = await db.select({ tv: users.tokenVersion, h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(row!.tv).toBe(1);
    expect(await verifyPassword(row!.h!, NEW_PW)).toBe(true);
    expect(collabHooks.onUserRevoked).toHaveBeenCalledWith(u.id);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: NEW_PW } })).statusCode).toBe(200);
  });

  it("already has a password -> 409 password_already_set and unchanged; double submit -> first 204, second 409", async () => {
    const { app, db } = await buildTestApp();
    const p = await insertPasswordUser(db);
    expect((await setPw(app, await cookieOf(p.id))).json().error.code).toBe("password_already_set");
    const u = await seedUser(db);
    const first = await setPw(app, await cookieOf(u.id));
    expect(first.statusCode).toBe(204);
    const fresh = { [SESSION_COOKIE]: first.cookies.find(c => c.name === SESSION_COOKIE)!.value };
    expect((await setPw(app, fresh, { newPassword: "another-password-456" })).json().error.code).toBe("password_already_set");
  });

  it("too short -> 400 password_too_short; invalid body -> 400; unauthenticated or Bearer -> 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    expect((await setPw(app, await cookieOf(u.id), { newPassword: "short" })).json().error.code).toBe("password_too_short");
    expect((await setPw(app, await cookieOf(u.id), { newPassword: NEW_PW, extra: 1 })).json().error.code).toBe("invalid_body");
    expect((await app.inject({ method: "POST", url: "/api/auth/password/set", payload: { newPassword: NEW_PW } })).statusCode).toBe(401);
    // Valid PAT (scope enough for authenticateTokenOrSession), no cookie: the 401 can only come from "session only".
    const { token } = await seedTokenForUser(db, u.id);
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/password/set", headers: bearer(token), payload: { newPassword: NEW_PW } })).statusCode,
    ).toBe(401);
  });

  it("HashBusyError -> 429 server_busy, unchanged", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    expect((await setPw(app, await cookieOf(u.id))).json().error.code).toBe("server_busy");
    const [row] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(row!.h).toBeNull();
  });

  it("effective off -> 403 password_login_disabled (no hashing); env force + DB off -> 204 (effective value decides)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await setPw(app, await cookieOf(u.id))).json().error.code).toBe("password_login_disabled");
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const v = await seedUser(forced.db);
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await setPw(forced.app, await cookieOf(v.id))).statusCode).toBe(204);
  });

  it("while off, POST /api/auth/password (change password) still succeeds and clears must_change_password; flagged account's /me still returns true", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { mustChangePassword: true });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().mustChangePassword).toBe(true);
    const res = await app.inject({ method: "POST", url: "/api/auth/password", cookies, payload: { currentPassword: u.password, newPassword: NEW_PW } });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
    expect(row!.m).toBe(false);
  });

  it("while off, a flagged account creating a PAT -> 403 (existing block unchanged)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { mustChangePassword: true });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const res = await app.inject({ method: "POST", url: "/api/auth/tokens", cookies: await cookieOf(u.id), payload: { name: "x", scope: "notes:read", expiresInDays: 30 } });
    expect(res.statusCode).toBe(403);
  });

  it("concurrent: another connection submits 'add password' first (uncommitted) -> real route blocks on the row lock -> after commit it re-evaluates WHERE -> 409, password is the first one's, token_version=1", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const cookies = await cookieOf(u.id);
    // Warm the gate cache so the real route's authenticate is not affected by the holder's uncommitted bump.
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("update users set password_hash = $1, token_version = token_version + 1 where id = $2 and password_hash is null", [await hashPassword("first-password-123"), u.id]);
      const pending = setPw(app, cookies, { newPassword: "second-password-456" });
      const state = await waitForBlockedOrSettled(db.$client, pending);
      await holder.query("commit");
      const res = await pending;
      expect(state).toBe("blocked");
      expect(res.statusCode).toBe(409);
      const [row] = await db.select({ h: users.passwordHash, tv: users.tokenVersion }).from(users).where(eq(users.id, u.id));
      expect(await verifyPassword(row!.h!, "first-password-123")).toBe(true);
      expect(row!.tv).toBe(1);
    } finally {
      await holder.end();
    }
  });

  // Guards the users lock in unlinkIdentityInTx (the holder's SQL is a hand copy of the route's); the add-password side is guarded by the concurrent case above.
  it("concurrent, second shape: another connection 'adds password' first (uncommitted) -> unlinking the last identity waits for its commit -> sees the password -> 204", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", enabled: false, clientSecret: null });
    const u = await seedUser(db);
    const [ident] = (await db.execute<{ id: string }>(sql`insert into user_identities (user_id, issuer, sub) values (${u.id}, 'https://a.example', 'sa') returning id`)).rows;
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("update users set password_hash = $1, token_version = token_version + 1 where id = $2 and password_hash is null", [await hashPassword(NEW_PW), u.id]);
      const pending = app.inject({ method: "DELETE", url: `/api/auth/identities/${ident!.id}`, cookies: { [SESSION_COOKIE]: await signTestSession({ userId: u.id, tv: 0 }) } });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
  });
});
