import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { resolveOidcLoginInTx } from "../src/auth/tx/oidc-login.js";
import { oneTimeLinks, siteSettings, users } from "../src/db/schema.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { basicPlanId, seedAttachment, seedPlan } from "./storage-helpers.js";

const PW = "correct-horse-battery-staple";
type B = Awaited<ReturnType<typeof adminApp>>;
const inviteOf = async (b: B): Promise<{ token: string; id: string }> => {
  const res = await b.app.inject({ method: "POST", url: "/api/admin/invites", cookies: b.cookies, payload: { expiresInDays: 1 } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { token: string; invite: { id: string } };
  return { token: body.token, id: body.invite.id };
};
const acceptInvite = (b: B, token: string, email: string) =>
  b.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, email, password: PW, displayName: "N" } });
/** Accounts are always created via admin-creates-invite -> accept invite without login (direct admin creation was removed in #285); returns the accept response. */
const createUser = async (b: B, email: string) => acceptInvite(b, (await inviteOf(b)).token, email);
const planOfUser = async (db: B["db"], id: string) => (await db.select({ p: users.storagePlanId }).from(users).where(eq(users.id, id)))[0]!.p;
/** Serialize the whole received log (an Error's message/stack/cause are non-enumerable and spread by hand - drizzle puts params into the message). */
const logText = (lines: Array<{ msg?: string; obj: Record<string, unknown> }>) =>
  JSON.stringify(lines, (_k, v: unknown) => (v instanceof Error ? { ...v, message: v.message, stack: v.stack, cause: v.cause } : v));

describe("AdminUserDto.storage and assignment", () => {
  it("GET /api/admin/users: each row carries the four storage fields (typeof number); suspended users still show usage", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db, { disabled: true });
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 4321);
    const res = await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies });
    const row = res.json().find((r: { id: string }) => r.id === u.id);
    expect(row.storage).toEqual({ planId: await basicPlanId(b.db), planName: "Basic", usedBytes: 4321, quotaBytes: 2147483648, contentBytes: 0 });
    expect(typeof row.storage.usedBytes).toBe("number");
    expect(row.disabledAt).not.toBeNull();
  });

  it("accepting an invite 201 -> the new account gets the current default, usage 0", async () => {
    const b = await adminApp();
    const p = await seedPlan(b.db, "NewDefault", 77);
    await b.db.update(siteSettings).set({ defaultUserStoragePlanId: p });
    const res = await createUser(b, "fresh@example.com");
    expect(res.statusCode).toBe(201);
    const list = await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies });
    const row = list.json().find((r: { id: string }) => r.id === res.json().id);
    expect(row.storage).toEqual({ planId: p, planName: "NewDefault", usedBytes: 0, quotaBytes: 77, contentBytes: 0 });
  });

  it("PATCH /api/admin/users/:id/storage-plan: 200 AdminUserDto; suspended users can be changed; user missing/non-UUID -> 404 user_not_found; plan missing/non-UUID -> 404 storage_plan_not_found; uppercase UUID works; site admin only", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db, { disabled: true });
    const p = await seedPlan(b.db, "P", null);
    const url = (id: string) => `/api/admin/users/${id}/storage-plan`;
    const ok = await b.app.inject({ method: "PATCH", url: url(u.id.toUpperCase()), cookies: b.cookies, payload: { planId: p.toUpperCase() } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: u.id, storage: { planId: p, planName: "P", quotaBytes: null, usedBytes: 0 } });
    expect(await planOfUser(b.db, u.id)).toBe(p);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await b.app.inject({ method: "PATCH", url: url(id), cookies: b.cookies, payload: { planId: p } })).json().error.code, id).toBe("user_not_found");
      expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: { planId: id } })).json().error.code, id).toBe("storage_plan_not_found");
    }
    expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: {} })).statusCode).toBe(400);
    expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: { planId: p, quotaBytes: 1 } })).statusCode).toBe(400);
    await expectAdminOnly(b.app, b.db, "PATCH", url(u.id), { planId: p });
  });
});

describe("all four account-creation paths pick up the current user default; existing accounts unchanged", () => {
  it("accept invite, register, OIDC auto-create, bootstrap", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    const p = await seedPlan(b.db, "P", 5);
    await b.db.update(siteSettings).set({ defaultUserStoragePlanId: p });

    const viaInvite = (await createUser(b, "a1@example.com")).json().id as string;
    const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "r1@example.com", password: PW, displayName: "R" } });
    expect(reg.statusCode).toBe(201);
    const op = await seedAuthProvider(b.db, { issuerUrl: "https://idp.example" });
    await b.db.transaction(tx =>
      resolveOidcLoginInTx(tx, {
        claims: { issuer: "https://idp.example", sub: "s-1", email: "o1@example.com", name: "O", preferredUsername: null },
        providerId: op.id,
        configVersion: op.configVersion,
      }),
    );
    const [oidcUser] = await b.db.select({ id: users.id }).from(users).where(eq(users.email, "o1@example.com"));
    expect(oidcUser, "OIDC 自動建帳應建出帳號（helper 預設開自動建帳）").toBeDefined();
    for (const id of [viaInvite, reg.json().id as string, oidcUser!.id]) expect(await planOfUser(b.db, id)).toBe(p);
    expect(await planOfUser(b.db, b.admin.id)).toBe(basic);

    const fresh = await freshDb();
    const fp = await seedPlan(fresh.db, "FP", 9);
    await fresh.db.update(siteSettings).set({ defaultUserStoragePlanId: fp });
    await initializeInstance(fresh.db, { email: "boot@example.com", password: PW });
    const [boot] = await fresh.db.select({ p: users.storagePlanId }).from(users).where(eq(users.email, "boot@example.com"));
    expect(boot!.p).toBe(fp);
  });
});

describe("site_settings has no row (contract change)", () => {
  it("accept invite -> 500 and log.error contains SITE_SETTINGS_MISSING_MESSAGE, log has no password hash, no account or handle row left, invite unused; POST /api/groups -> 500 with the same log line, no group left", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    // The invite is created before deleting the row (creating it after also works: an unreadable row counts as password login on).
    const invite = await inviteOf(b);
    await b.db.delete(siteSettings);
    const before = (await b.db.$client.query("select (select count(*)::int from users) u, (select count(*)::int from handles) h, (select count(*)::int from groups) g")).rows[0];
    const missing = () => logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE).length;
    const r = await acceptInvite(b, invite.token, "x@example.com");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });
    expect(missing()).toBe(1);
    expect(logText(logs.lines).includes("$argon2"), "log 帶了密碼雜湊").toBe(false);
    expect((await b.app.inject({ method: "POST", url: "/api/groups", cookies: b.cookies, payload: { name: "G" } })).statusCode).toBe(500);
    expect(missing()).toBe(2);
    const after = (await b.db.$client.query("select (select count(*)::int from users) u, (select count(*)::int from handles) h, (select count(*)::int from groups) g")).rows[0];
    expect(after).toEqual(before);
    const [link] = await b.db.select({ usedAt: oneTimeLinks.usedAt }).from(oneTimeLinks).where(eq(oneTimeLinks.id, invite.id));
    expect(link!.usedAt).toBeNull();
  });

  it("first bootstrap start -> throws 23502 (column storage_plan_id), no account row left", async () => {
    const fresh = await freshDb();
    await fresh.db.delete(siteSettings);
    // Not toThrow(/storage_plan_id/): a DrizzleQueryError message contains the whole INSERT column list anyway, so any failure would match.
    const err = await initializeInstance(fresh.db, { email: "boot@example.com", password: PW }).catch(e => e);
    expect(err?.cause ?? err).toMatchObject({ code: "23502", column: "storage_plan_id" });
    expect(await fresh.db.select().from(users)).toEqual([]);
  });
});

describe("account/group creation hitting a deleted default plan -> 409 server_busy (23503 built with a trigger)", () => {
  it("accept invite: users_storage_plan_fk -> 409 server_busy; a 23503 with another name is still 500 and the log records only the masked summary (no password hash)", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.$client.query(`
      create function pg_temp_raise_users_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'users_storage_plan_fk', message = 'constructed'; end $$;
      create trigger t_users_fk before insert on users for each row execute function pg_temp_raise_users_fk();`);
    const r = await createUser(b, "y@example.com");
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
    await b.db.$client.query(`
      create or replace function pg_temp_raise_users_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'something_else_fk', message = 'constructed'; end $$;`);
    expect((await createUser(b, "z@example.com")).statusCode).toBe(500);
    // Assert no leak first: if masking is removed it must go red here, not be hidden by the context structure assertions below.
    expect(logText(logs.lines).includes("$argon2"), "log 帶了密碼雜湊").toBe(false);
    expect(logs.lines.some(l => l.level === "error" && l.obj.code === "23503" && l.obj.constraint === "something_else_fk" && l.obj.context === "接受邀請")).toBe(true);
  });

  it("POST /api/groups: groups_storage_plan_fk -> 409 server_busy, no group left", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await db.$client.query(`
      create function pg_temp_raise_groups_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'groups_storage_plan_fk', message = 'constructed'; end $$;
      create trigger t_groups_fk before insert on groups for each row execute function pg_temp_raise_groups_fk();`);
    const r = await app.inject({ method: "POST", url: "/api/groups", cookies: await cookieOf(u.id), payload: { name: "G" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("server_busy");
    expect((await db.$client.query("select count(*)::int n from groups")).rows[0].n).toBe(0);
  });
});
