import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, userIdentities, users } from "../src/db/schema.js";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
type Built = Awaited<ReturnType<typeof adminApp>>;

async function holderFor(db: Built["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}
const get = (b: Built) => b.app.inject({ method: "GET", url: "/api/admin/auth/settings", cookies: b.cookies });
const patch = (b: Built, payload: object, cookies = b.cookies) => b.app.inject({ method: "PATCH", url: "/api/admin/auth/settings", cookies, payload });
const dbSettings = async (b: Built) => (await b.db.select().from(siteSettings))[0]!;
async function identity(db: Built["db"], userId: string, issuer: string, sub: string): Promise<string> {
  const [row] = await db.insert(userIdentities).values({ userId, issuer, sub }).returning({ id: userIdentities.id });
  return row!.id;
}
const patchProvider = (b: Built, id: string, payload: object) =>
  b.app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies: b.cookies, payload });

/** Waits until at least `n` connections on this test DB are waiting on locks (`waitForBlockedOrSettled` only accepts >= 1; use this when two real requests must both be blocked). */
async function waitForLockWaiters(pool: Built["db"]["$client"], n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等不到 ${n} 條等鎖連線（${timeoutMs}ms）`);
}

/**
 * Interleaving where both sides are real routes: the holder holds only an ACCESS EXCLUSIVE table lock on `auth_providers` (any statement reading it blocks),
 * halting `first` mid-transaction (after it took its site-settings row lock / FOR SHARE, while reading `auth_providers`); `second` is then sent and also blocks
 * (on the row lock `first` holds); after the table lock is released `first` commits first and `second` runs. The holder simulates neither side's writes.
 */
async function interleave<T, U>(b: Built, first: () => Promise<T>, second: () => Promise<U>): Promise<[T, U]> {
  const holder = await holderFor(b.db);
  try {
    await holder.query("begin");
    await holder.query("lock table auth_providers in access exclusive mode");
    const p1 = first();
    expect(await waitForBlockedOrSettled(b.db.$client, p1)).toBe("blocked");
    const p2 = second();
    await waitForLockWaiters(b.db.$client, 2);
    await holder.query("commit");
    return [await p1, await p2];
  } finally {
    await holder.end();
  }
}

describe("GET /api/admin/auth/settings (#187)", () => {
  it("site admins only (GET and PATCH)", async () => {
    const b = await adminApp();
    await expectAdminOnly(b.app, b.db, "GET", "/api/admin/auth/settings");
    await expectAdminOnly(b.app, b.db, "PATCH", "/api/admin/auth/settings", { registrationEnabled: true });
  });

  it("default shape: DB values and passwordLoginForced are separate; three impact fields", async () => {
    const b = await adminApp();
    expect((await get(b)).json()).toEqual({
      registrationEnabled: true,
      passwordLoginEnabled: true,
      passwordLoginForced: false,
      passwordLoginImpact: { usersWithoutSso: 1, actingAdminHasSso: false, enabledProviders: 0 },
    });
    const forced = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await get(forced)).json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginForced: true });
  });

  it("usersWithoutSso: identity whose provider is disabled counts; slash-less identity + trailing-slash provider with resolved_issuer written doesn't count; disabled accounts don't count", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await seedAuthProvider(b.db, { issuerUrl: "https://off.example", enabled: false, clientSecret: null });
    const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
    await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
    const linkedOff = await seedUser(b.db);
    await identity(b.db, linkedOff.id, "https://off.example", "x");
    const linkedSlash = await seedUser(b.db);
    await identity(b.db, linkedSlash.id, B, "y");
    await seedUser(b.db, { disabled: true });
    // admin (no identity) + linkedOff = 2; linkedSlash and disabled don't count
    expect((await get(b)).json().passwordLoginImpact).toEqual({ usersWithoutSso: 2, actingAdminHasSso: false, enabledProviders: 2 });
  });

  it("site_settings row unreadable -> registration false, passwordLogin true + error log (not a 500)", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
    expect(logs.lines.some(l => l.level === "error" && l.msg?.includes("site_settings"))).toBe(true);
  });
});

describe("PATCH /api/admin/auth/settings (#187)", () => {
  it("body: {} -> 400; extra fields -> 400; non-boolean -> 400", async () => {
    const b = await adminApp();
    for (const body of [{}, { registrationEnabled: true, x: 1 }, { passwordLoginEnabled: "false" }]) {
      expect((await patch(b, body)).json().error.code).toBe("invalid_body");
    }
  });

  it("changing only registrationEnabled -> 200, same shape as GET; the self-lockout guard is not evaluated (DB already off, admin without SSO still 200, DB value stays off)", async () => {
    const b = await adminApp();
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    const res = await patch(b, { registrationEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: false, passwordLoginForced: false });
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: false });
  });

  it("zero enabled providers -> 409 sso_provider_required, DB unchanged", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    const res = await patch(b, { passwordLoginEnabled: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("operator has no usable identity (no identity / identity's provider disabled) -> 409 admin_sso_link_required; with both conditions satisfied -> 200", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
    await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null });
    await identity(b.db, b.admin.id, B, "admin-b");
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
    await identity(b.db, b.admin.id, A, "admin-a");
    const ok = await patch(b, { passwordLoginEnabled: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginImpact: { actingAdminHasSso: true, enabledProviders: 1 } });
  });

  it("same result while env forces it (decided by the DB value); turning on is always 200 (even with zero providers)", async () => {
    const b = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("sso_provider_required");
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await patch(b, { passwordLoginEnabled: true })).statusCode).toBe(200);
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("DB already off, admin without SSO, idempotent resend of false -> 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
  });

  it("changing two switches where the password half is blocked -> 409, the registration switch is unchanged too (whole request rolled back)", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const res = await patch(b, { registrationEnabled: false, passwordLoginEnabled: false });
    expect(res.json().error.code).toBe("admin_sso_link_required");
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: true, passwordLoginEnabled: true });
  });

  it("after turning it off from a password session, that session stays valid and can turn it back on; password login works after turning it back on", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const pw = await insertPasswordUser(b.db, { password: "correct-horse-battery-staple" });
    await b.db.update(users).set({ isAdmin: true }).where(sql`id = ${pw.id}`);
    await identity(b.db, pw.id, A, "pw-a");
    const login = await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } });
    const cookies = { [SESSION_COOKIE]: login.cookies.find(c => c.name === SESSION_COOKIE)!.value };
    expect((await patch(b, { passwordLoginEnabled: false }, cookies)).statusCode).toBe(200);
    expect((await b.app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect((await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } })).statusCode).toBe(403);
    expect((await patch(b, { passwordLoginEnabled: true }, cookies)).statusCode).toBe(200);
    expect((await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } })).statusCode).toBe(200);
  });

  it("audit log: one line only when passwordLoginEnabled changes (operator, new value, passwordLoginForced); nothing when unchanged", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    await patch(b, { passwordLoginEnabled: true });
    expect(logs.lines.filter(l => l.msg === "帳密登入開關被變更")).toEqual([]);
    await patch(b, { passwordLoginEnabled: false });
    const lines = logs.lines.filter(l => l.msg === "帳密登入開關被變更");
    expect(lines.map(l => l.obj)).toEqual([expect.objectContaining({ userId: b.admin.id, passwordLoginEnabled: false, passwordLoginForced: false })]);
  });

  it("site_settings row unreadable -> 500 + log.error", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    expect((await patch(b, { registrationEnabled: true })).statusCode).toBe(500);
    expect(logs.lines.some(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toBe(true);
  });

  it("compared by effective issuer: identity = resolved_issuer, provider's issuer_url has a trailing slash -> turning off gives 200, actingAdminHasSso true (absolute value, not just cell-by-cell consistency)", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
    await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
    await identity(b.db, b.admin.id, B, "x");
    const res = await patch(b, { passwordLoginEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginImpact: { actingAdminHasSso: true, usersWithoutSso: 0 } });
  });

  it("actingAdminHasSso=false <=> turning off PATCH returns admin_sso_link_required (same function, consistent cell by cell)", async () => {
    const cells: Array<[string, (b: Built) => Promise<void>]> = [
      ["無身分", async () => {}],
      ["身分的 provider 停用", async b => { await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null }); await identity(b.db, b.admin.id, B, "x"); }],
      ["精確相等", async b => { await identity(b.db, b.admin.id, A, "x"); }],
      ["尾斜線＋resolved 已寫", async b => {
        const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
        await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
        await identity(b.db, b.admin.id, B, "x");
      }],
      ["尾斜線＋resolved 未寫（C31：只會誤擋）", async b => { await seedAuthProvider(b.db, { issuerUrl: `${B}/` }); await identity(b.db, b.admin.id, B, "x"); }],
    ];
    for (const [name, arrange] of cells) {
      const b = await adminApp();
      await seedAuthProvider(b.db, { issuerUrl: A });
      await arrange(b);
      const hasSso = (await get(b)).json().passwordLoginImpact.actingAdminHasSso as boolean;
      const res = await patch(b, { passwordLoginEnabled: false });
      expect(res.statusCode === 409 && res.json().error.code === "admin_sso_link_required", name).toBe(!hasSso);
    }
  });
});

describe("concurrency (#187)", () => {
  it("lost update: another connection holds the lock and sets registration_enabled false (uncommitted) -> this side changes only passwordLoginEnabled:true and waits for the commit -> registration still false", async () => {
    const b = await adminApp();
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set registration_enabled = false");
      const pending = patch(b, { passwordLoginEnabled: true });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
  });

  it("another connection disables the last provider (holding the site-settings row lock, uncommitted) -> turning off password login waits for the commit -> 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update auth_providers set enabled = false where id = $1", [p.id]);
      const pending = patch(b, { passwordLoginEnabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("turning off takes the lock first (uncommitted) -> unlinking 'password + last identity' waits for the commit -> reads off -> 409 last_login_method", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const u = await insertPasswordUser(b.db);
    const idA = await identity(b.db, u.id, A, "ua");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idA}`, cookies: await cookieOf(u.id) });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("last_login_method");
    } finally {
      await holder.end();
    }
  });

  it("unlink takes FOR SHARE first (uncommitted, the admin's only identity deleted) -> turning off waits for the commit -> the self-lockout check sees the identity gone -> 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const idA = await identity(b.db, b.admin.id, A, "admin-a");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [b.admin.id]);
      await holder.query("select password_login_enabled from site_settings where singleton for share");
      await holder.query("delete from user_identities where id = $1", [idA]);
      const pending = patch(b, { passwordLoginEnabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("admin_sso_link_required");
    } finally {
      await holder.end();
    }
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });
});

describe("concurrency: both sides are real routes (holder only holds a table lock, simulates neither side)", () => {
  it("real shape: settings PATCH turning off takes the site-settings row lock first -> provider PATCH disabling the last provider waits for the commit -> 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [close, disable] = await interleave(b, () => patch(b, { passwordLoginEnabled: false }), () => patchProvider(b, p.id, { enabled: false }));
    expect(close.statusCode).toBe(200);
    expect(disable.statusCode).toBe(409);
    expect(disable.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(false);
    expect((await b.db.execute<{ n: number }>(sql`select count(*)::int as n from auth_providers where enabled`)).rows[0]!.n).toBe(1);
  });

  it("real shape: DB off; provider PATCH disabling p1 takes the lock first -> another request disabling p2 waits for the commit -> 409, p2 still enabled at the end", async () => {
    const b = await adminApp();
    const p1 = await seedAuthProvider(b.db, { issuerUrl: A });
    const p2 = await seedAuthProvider(b.db, { issuerUrl: B });
    await identity(b.db, b.admin.id, A, "a");
    await identity(b.db, b.admin.id, B, "b");
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    const [r1, r2] = await interleave(b, () => patchProvider(b, p1.id, { enabled: false }), () => patchProvider(b, p2.id, { enabled: false }));
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("sso_provider_required");
    const enabled = (await b.db.execute<{ id: string }>(sql`select id from auth_providers where enabled`)).rows.map(r => r.id);
    expect(enabled).toEqual([p2.id]);
  });

  it("real shape: provider PATCH disabling the last provider takes the lock first (DB on, not checked) -> settings PATCH turning off waits for the commit -> 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [disable, close] = await interleave(b, () => patchProvider(b, p.id, { enabled: false }), () => patch(b, { passwordLoginEnabled: false }));
    expect(disable.statusCode).toBe(200);
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("lost update, real shape: settings PATCH (registration off + password login off) takes the lock first -> another request turning only password login on waits for the commit -> registration stays off, password login on", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [r1, r2] = await interleave(
      b,
      () => patch(b, { registrationEnabled: false, passwordLoginEnabled: false }),
      () => patch(b, { passwordLoginEnabled: true }),
    );
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
  });

  it("real shape: settings PATCH turning off takes the lock first -> unlinking 'password + last identity' waits for the commit -> reads off -> 409 last_login_method", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "admin-a");
    const u = await insertPasswordUser(b.db);
    const idU = await identity(b.db, u.id, A, "ua");
    const uCookies = await cookieOf(u.id);
    const [close, unlink] = await interleave(
      b,
      () => patch(b, { passwordLoginEnabled: false }),
      () => b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idU}`, cookies: uCookies }),
    );
    expect(close.statusCode).toBe(200);
    expect(unlink.statusCode).toBe(409);
    expect(unlink.json().error.code).toBe("last_login_method");
  });

  it("real shape: unlink (admin has a password, deleting the only identity) takes FOR SHARE first -> settings PATCH turning off waits for the commit -> 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.update(users).set({ passwordHash: "not-a-real-hash" }).where(sql`id = ${b.admin.id}`);
    const idA = await identity(b.db, b.admin.id, A, "admin-a");
    const [unlink, close] = await interleave(
      b,
      () => b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idA}`, cookies: b.cookies }),
      () => patch(b, { passwordLoginEnabled: false }),
    );
    expect(unlink.statusCode).toBe(204);
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("admin_sso_link_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });
});
