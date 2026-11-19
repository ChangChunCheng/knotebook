import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { handles, siteSettings, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters, insertPasswordUser, testConfig, type TestApp } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});
import { HashBusyError, hashPassword, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(hashPassword).mockClear());

const PW = "correct-horse-battery-staple";
const NUL = String.fromCodePoint(0);
const lastLoginOf = async (db: Db, id: string) =>
  (await db.execute<{ t: string | null }>(sql`select last_login_at::text as t from users where id = ${id}`)).rows[0]!.t;
const register = (app: TestApp["app"], payload: object) => app.inject({ method: "POST", url: "/api/auth/register", payload });

async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}

describe("POST /api/auth/register (#187)", () => {
  it("success -> 201 UserDto, session issued (/me works), must_change_password=false, handle derived from the email local-part", async () => {
    const { app, db } = await buildTestApp();
    const res = await register(app, { email: "new.user@example.com", password: PW, displayName: "New User" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "new.user@example.com", displayName: "New User", isAdmin: false, mustChangePassword: false, hasPassword: true });
    const session = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: session } });
    expect(me.json().id).toBe(res.json().id);
    const [row] = await db.select().from(users).where(eq(users.id, res.json().id));
    expect(row!.mustChangePassword).toBe(false);
    expect(await verifyPassword(row!.passwordHash!, PW)).toBe(true);
    expect(row!.handle).toBe("new-user");
    const [h] = await db.select().from(handles).where(eq(handles.userId, row!.id));
    expect(h).toMatchObject({ handle: "new-user", state: "live" });
    expect(await lastLoginOf(db, res.json().id)).not.toBeNull();
  });

  it("no display name -> uses the email local-part", async () => {
    const { app } = await buildTestApp();
    const res = await register(app, { email: "solo@example.com", password: PW });
    expect(res.json().displayName).toBe("solo");
  });

  it("email with surrounding whitespace and uppercase -> stored normalized lowercase; later login with lowercase works; display name containing NUL -> 400, not 500", async () => {
    const { app, db } = await buildTestApp();
    const res = await register(app, { email: "  Alice@X.Example ", password: PW });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe("alice@x.example");
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alice@x.example", password: PW } });
    expect(login.statusCode).toBe(200);
    const bad = await register(app, { email: "bob@x.example", password: PW, displayName: `Bo${NUL}b` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_body");
    expect(bad.json().error.message).toBe("The display name contains characters that can't be stored.");
    expect(await db.select().from(users).where(eq(users.email, "bob@x.example"))).toEqual([]);
  });

  it("limits: email of 255 chars -> 400 (English message), 254 -> 201; display name of 101 code points -> 400, 100 -> 201", async () => {
    const { app, db } = await buildTestApp();
    const emailOf = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
    const long = await register(app, { email: emailOf(255), password: PW });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe("The email can be at most 254 characters.");
    const longLocal = await register(app, { email: emailOf(254), password: PW });
    expect(longLocal.statusCode).toBe(201);
    // Without a display name the default is the local-part (242 chars), truncated to the first 100 code points.
    expect(longLocal.json().displayName).toBe("a".repeat(100));
    const [longRow] = await db.select().from(users).where(eq(users.id, longLocal.json().id));
    expect(longRow!.displayName).toBe("a".repeat(100));
    const tooLongName = await register(app, { email: "n1@example.com", password: PW, displayName: "😀".repeat(101) });
    expect(tooLongName.json().error).toEqual({ code: "invalid_body", message: "The display name can be at most 100 characters." });
    expect((await register(app, { email: "n2@example.com", password: PW, displayName: "😀".repeat(100) })).statusCode).toBe(201);
  });

  it("email already exists -> 409; registering `alice@x` when `Alice@x` (old mixed-case row) exists -> 409 email_taken", async () => {
    const { app, db } = await buildTestApp();
    await insertPasswordUser(db, { email: "taken@example.com" });
    expect((await register(app, { email: "taken@example.com", password: PW })).json().error.code).toBe("email_taken");
    await db.insert(users).values({ email: "Legacy@Example.com", displayName: "Old" });
    const res = await register(app, { email: "legacy@example.com", password: PW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("email_taken");
  });

  it("password too short -> 400 password_too_short; invalid body -> 400 invalid_body (English message)", async () => {
    const { app } = await buildTestApp();
    expect((await register(app, { email: "a@example.com", password: "short" })).json().error.code).toBe("password_too_short");
    const bad = await register(app, { email: "not-an-email", password: PW });
    expect(bad.json().error).toEqual({ code: "invalid_body", message: "Invalid request body." });
    expect((await register(app, { email: "a@example.com", password: PW, isAdmin: true })).statusCode).toBe(400);
  });

  it("password self-registration off -> 403 registration_disabled (fast path, no hashing)", async () => {
    const { app, db } = await buildTestApp();
    await db.update(siteSettings).set({ registrationEnabled: false });
    const res = await register(app, { email: "x@example.com", password: PW });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("registration_disabled");
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
  });

  it("effective password login off -> 403 password_login_disabled; both off -> registration_disabled; env force + DB off -> 201", async () => {
    const { app, db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await register(app, { email: "p@example.com", password: PW })).json().error.code).toBe("password_login_disabled");
    await db.update(siteSettings).set({ registrationEnabled: false });
    expect((await register(app, { email: "p@example.com", password: PW })).json().error.code).toBe("registration_disabled");
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await register(forced.app, { email: "p@example.com", password: PW })).statusCode).toBe(201);
  });

  it("unreadable site_settings row -> registration treated as off (403 registration_disabled)", async () => {
    const { app, db } = await buildTestApp();
    await db.delete(siteSettings);
    expect((await register(app, { email: "x@example.com", password: PW })).json().error.code).toBe("registration_disabled");
  });

  it("password self-registration depends only on registration_enabled plus the effective password-login value, not on providers' auto-create", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://idp.example", autoCreateEnabled: true });
    await db.update(siteSettings).set({ registrationEnabled: false });
    const res = await register(app, { email: "x@example.com", password: PW });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("registration_disabled");
    expect(await db.select().from(users)).toHaveLength(0);
    const b = await buildTestApp();
    await seedAuthProvider(b.db, { issuerUrl: "https://idp.example", autoCreateEnabled: false });
    expect((await register(b.app, { email: "y@example.com", password: PW })).statusCode).toBe(201);
  });

  it("HashBusyError -> 429 server_busy, no account created", async () => {
    const { app, db } = await buildTestApp();
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    const res = await register(app, { email: "busy@example.com", password: PW });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("server_busy");
    expect(await db.select().from(users).where(eq(users.email, "busy@example.com"))).toEqual([]);
  });

  it("per-IP limit (REGISTER_LIMIT): quota used up -> 429 too_many_requests", async () => {
    const { app } = await buildTestApp({ limiters: freshLimiters({ register: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    expect((await register(app, { email: "one@example.com", password: PW })).statusCode).toBe(201);
    expect((await register(app, { email: "two@example.com", password: PW })).json().error.code).toBe("too_many_requests");
  });

  it("handle collision retry: the local-part's handle is taken -> another one is derived, still 201", async () => {
    const { app, db } = await buildTestApp();
    await db.insert(users).values({ email: "someone@else.example", displayName: "X", handle: "dup" });
    await db.insert(handles).values({ handle: "dup", userId: (await db.select({ id: users.id }).from(users).where(eq(users.handle, "dup")))[0]!.id, state: "live" });
    const res = await register(app, { email: "dup@example.com", password: PW });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).not.toBe("dup");
  });

  it("fast path reads on, FOR SHARE inside the transaction waits for the close to commit and reads off -> 403 registration_disabled, no account", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set registration_enabled = false");
      const pending = register(app, { email: "c9@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.json().error.code).toBe("registration_disabled");
    } finally {
      await holder.end();
    }
    expect(await db.select().from(users).where(eq(users.email, "c9@example.com"))).toEqual([]);
  });

  it("same shape, but password login is the one turned off -> 403 password_login_disabled, no account", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = register(app, { email: "c27@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("password_login_disabled");
    } finally {
      await holder.end();
    }
    expect(await db.select().from(users).where(eq(users.email, "c27@example.com"))).toEqual([]);
  });

  it("SSO first, then register -> 409: another connection holds an uncommitted users row with the same email (SSO first login mid-creation) -> register waits for its commit -> 409 email_taken", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("insert into users (email, display_name, handle) values ('c3@example.com', 'C3', 'c3-holder')");
      const pending = register(app, { email: "c3@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("email_taken");
    } finally {
      await holder.end();
    }
  });

  it("unexpected DB error in the transaction -> 500, log masked (context 'register', no password hash, no params); users/handles have no new rows", async () => {
    const out: string[] = [];
    const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
    const { app, db } = await buildTestApp({}, {
      logger: {
        level: "info",
        stream: { write: (chunk: string) => void out.push(chunk) },
        hooks: {
          logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
            const [obj, msg] = args as [Record<string, unknown>, string | undefined];
            if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
            method.apply(this, args as never[]);
          },
        },
      },
    });
    const usersBefore = (await db.select({ id: users.id }).from(users)).length;
    const handlesBefore = (await db.select({ handle: handles.handle }).from(handles)).length;
    await db.execute(sql.raw("ALTER TABLE users ADD CONSTRAINT t285_block CHECK (false) NOT VALID"));
    const res = await register(app, { email: "rgr@example.com", password: PW });
    expect(res.statusCode).toBe(500);
    const hit = lines.filter(l => l.obj.context === "註冊");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.msg).toBe("註冊時發生非預期的資料庫錯誤（錯誤本體已遮蔽）");
    const all = out.join("");
    expect(all).not.toContain("$argon2");
    expect(all).not.toMatch(/params: |"params"\s*:/);
    await db.execute(sql.raw("ALTER TABLE users DROP CONSTRAINT t285_block"));
    expect((await db.select({ id: users.id }).from(users)).length).toBe(usersBefore);
    expect((await db.select({ handle: handles.handle }).from(handles)).length).toBe(handlesBefore);
  });
});
