import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { siteSettings, userIdentities } from "../src/db/schema.js";
import { testConfig } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, providerRow } from "./helpers/admin-auth.js";
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
const patchProvider = (b: Built, id: string, payload: object) =>
  b.app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies: b.cookies, payload });
const off = (b: Built) => b.db.update(siteSettings).set({ passwordLoginEnabled: false });

describe("self-lockout guard of provider PATCH (#187)", () => {
  it("DB off, disabling the only enabled provider -> 409 sso_provider_required, still enabled", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    const res = await patchProvider(b, p.id, { enabled: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("sso_provider_required");
    expect((await providerRow(b.db, p.id))!.enabled).toBe(true);
  });

  it("DB off, changing issuer (implies disabling) of the only provider -> 409, secret/issuer/version all unchanged (whole request rolled back)", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A, configVersion: 3 });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    const before = await providerRow(b.db, p.id);
    const res = await patchProvider(b, p.id, { issuerUrl: "https://moved.example" });
    expect(res.json().error.code).toBe("sso_provider_required");
    expect(await providerRow(b.db, p.id)).toEqual(before);
  });

  it("DB off, disabling the only one the operator is linked to (another enabled provider exists) -> 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    const pa = await seedAuthProvider(b.db, { issuerUrl: A });
    await seedAuthProvider(b.db, { issuerUrl: B });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    expect((await patchProvider(b, pa.id, { enabled: false })).json().error.code).toBe("admin_sso_link_required");
  });

  it("same result while env forces it; DB on, disabling the last provider -> 200", async () => {
    const forced = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const p = await seedAuthProvider(forced.db, { issuerUrl: A });
    await off(forced);
    expect((await patchProvider(forced, p.id, { enabled: false })).json().error.code).toBe("sso_provider_required");
    const b = await adminApp();
    const q = await seedAuthProvider(b.db, { issuerUrl: A });
    expect((await patchProvider(b, q.id, { enabled: false })).statusCode).toBe(200);
  });

  it("DB off, a PATCH that doesn't change enabled (name only) skips the guard -> 200 (even if the operator has no SSO): once for an enabled provider, once for one that was already disabled", async () => {
    const b = await adminApp();
    const on = await seedAuthProvider(b.db, { issuerUrl: A });
    const offAlready = await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null });
    await off(b);
    expect((await patchProvider(b, on.id, { displayName: "Renamed" })).statusCode).toBe(200);
    // Already disabled: enabled is still false after the write; only true -> false is checked, otherwise the "operator must have an identity at an enabled provider" check would block it (the operator has no SSO).
    expect((await patchProvider(b, offAlready.id, { displayName: "Renamed too" })).statusCode).toBe(200);
  });

  it("site_settings row unreadable -> PATCH and DELETE both 500 + log.error", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    const p = await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    await b.db.delete(siteSettings);
    expect((await patchProvider(b, p.id, { displayName: "x" })).statusCode).toBe(500);
    expect((await b.app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies: b.cookies })).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toHaveLength(2);
  });
});

describe("provider writes serialize on the site_settings row", () => {
  it("another connection turns off password login (holding the lock, uncommitted) -> disabling the last provider waits for the commit -> 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = patchProvider(b, p.id, { enabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await providerRow(b.db, p.id))!.enabled).toBe(true);
  });

  it("DB off; another connection disables p1 (holding the lock, uncommitted) -> this side disables p2 and waits for the commit -> 409, at least one enabled at the end", async () => {
    const b = await adminApp();
    const p1 = await seedAuthProvider(b.db, { issuerUrl: A });
    const p2 = await seedAuthProvider(b.db, { issuerUrl: B });
    await b.db.insert(userIdentities).values([{ userId: b.admin.id, issuer: A, sub: "a" }, { userId: b.admin.id, issuer: B, sub: "b" }]);
    await off(b);
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update auth_providers set enabled = false where id = $1", [p1.id]);
      const pending = patchProvider(b, p2.id, { enabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await providerRow(b.db, p2.id))!.enabled).toBe(true);
  });

  it("DELETE also takes the site-settings row lock: another connection holds the lock -> DELETE waits for the commit -> 204", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      const pending = b.app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies: b.cookies });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
  });
});
