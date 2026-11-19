import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { groups, handles, siteSettings, users } from "../src/db/schema.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";

async function call(app: FastifyInstance, method: "GET" | "PATCH" | "POST", url: string, who: string | null, payload?: unknown) {
  return app.inject({ method, url, ...(who ? { cookies: await cookieOf(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe("site settings /api/admin/versions/settings", () => {
  it("site admin only; GET defaults 7/30/on; PATCH merges a single field; violating 1 <= F <= D <= 3650 -> 400 and nothing changes; non-integer, empty body, several fields -> 400", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const user = await seedUser(db);
    const url = "/api/admin/versions/settings";
    expect((await call(app, "GET", url, null)).statusCode).toBe(401);
    expect((await call(app, "GET", url, user.id)).statusCode).toBe(403);
    expect((await call(app, "GET", url, admin.id)).json()).toEqual({ keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 });
    expect((await call(app, "PATCH", url, admin.id, { keepAllDays: 3 })).json()).toEqual({ keepAllDays: 3, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 });
    for (const body of [{ dailyUntilDays: 2 }, { keepAllDays: 0 }, { dailyUntilDays: 3651 }, { keepAllDays: 31 }]) {
      const r = await call(app, "PATCH", url, admin.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
      expect(r.json().error.message).toMatch(/3650/);
    }
    for (const body of [{}, { keepAllDays: 1.5 }, { keepAllDays: "3" }, { foo: 1 }]) expect((await call(app, "PATCH", url, admin.id, body)).statusCode).toBe(400);
    expect((await call(app, "GET", url, admin.id)).json()).toEqual({ keepAllDays: 3, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 });
    expect((await call(app, "PATCH", url, admin.id, { autoVersionsEnabled: false, keepAllDays: 1, dailyUntilDays: 1 })).json()).toEqual({ keepAllDays: 1, dailyUntilDays: 1, autoVersionsEnabled: false, autoWaitMinutes: 5 });
    expect((await call(app, "PATCH", url, user.id, { keepAllDays: 2 })).statusCode).toBe(403);
  });

  it("no site_settings row -> GET/PATCH 500, the log.error object starts with table", async () => {
    const logs = captureLogs();
    const { app, db } = await buildTestApp({}, logs.options);
    const admin = await seedUser(db, { isAdmin: true });
    await db.delete(siteSettings);
    expect((await call(app, "GET", "/api/admin/versions/settings", admin.id)).statusCode).toBe(500);
    expect((await call(app, "PATCH", "/api/admin/versions/settings", admin.id, { keepAllDays: 2 })).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.obj.table === "site_settings").length).toBeGreaterThanOrEqual(2);
  });

  it("the master switch is in the public /api/auth/config", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().autoVersionsEnabled).toBe(true);
    await call(app, "PATCH", "/api/admin/versions/settings", admin.id, { autoVersionsEnabled: false });
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().autoVersionsEnabled).toBe(false);
  });

  it("#272: autoWaitMinutes - GET default 5; PATCH 1 and 60 succeed; 0 and 61 -> 400 with the range sentence; 1.5 and the string '5' -> 400 'Invalid request body.'; none stored; writing 0 directly in the DB -> 23514", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const url = "/api/admin/versions/settings";
    expect((await call(app, "GET", url, admin.id)).json()).toEqual({ keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 });
    for (const m of [1, 60]) {
      const r = await call(app, "PATCH", url, admin.id, { autoWaitMinutes: m });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: m });
    }
    const RANGE = "The auto-save wait must be a whole number of minutes from 1 to 60.";
    for (const [body, message] of [
      [{ autoWaitMinutes: 0 }, RANGE],
      [{ autoWaitMinutes: 61 }, RANGE],
      [{ autoWaitMinutes: 1.5 }, "Invalid request body."],
      [{ autoWaitMinutes: "5" }, "Invalid request body."],
    ] as const) {
      const r = await call(app, "PATCH", url, admin.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error).toEqual({ code: "invalid_body", message });
    }
    expect((await call(app, "GET", url, admin.id)).json().autoWaitMinutes).toBe(60);
    await expect(db.$client.query(`update site_settings set version_auto_wait_minutes = 0`)).rejects.toMatchObject({ code: "23514", constraint: "site_settings_version_auto_wait_chk" });
  });
});

describe("personal switch PATCH /api/auth/profile", () => {
  it("autoVersions only: plain UPDATE, returns the written UserDto, /me reflects it at once, 6 changes in a row do not consume the rename quota", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const handlesBefore = await db.select().from(handles).where(eq(handles.userId, u.id));
    for (let i = 0; i < 6; i += 1) {
      const r = await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: i % 2 === 0 });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id: u.id, handle: u.handle, autoVersions: i % 2 === 0 });
    }
    // The last write is false (!= initial true): if the gate cache were not invalidated, /me would return the true cached by the first authenticate.
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().autoVersions).toBe(false);
    expect(await db.select().from(handles).where(eq(handles.userId, u.id))).toEqual(handlesBefore);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { handle: `${u.handle}-x` })).statusCode).toBe(200); // quota not consumed
  });

  it("autoVersions sent with an invalid or already taken handle -> 400/409, auto_versions unchanged; both fields valid -> both take effect in the same transaction", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: "Bad Handle!" })).statusCode).toBe(400);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: other.handle })).statusCode).toBe(409);
    expect((await db.select({ a: users.autoVersions }).from(users).where(eq(users.id, u.id)))[0]!.a).toBe(true);
    const ok = await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: `${u.handle}-y` });
    expect(ok.json()).toMatchObject({ handle: `${u.handle}-y`, autoVersions: false });
  });

  it("empty body, wrong type -> 400; existing handle-only behaviour unchanged (response carries autoVersions)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    for (const body of [{}, { autoVersions: "no" }, { handle: 5 }]) expect((await call(app, "PATCH", "/api/auth/profile", u.id, body)).statusCode).toBe(400);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { handle: `${u.handle}-z` })).json()).toMatchObject({ handle: `${u.handle}-z`, autoVersions: true });
  });

  it("both the login response and /api/auth/me carry autoVersions", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const password = "correct-horse-battery";
    await db.update(users).set({ autoVersions: false, passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().autoVersions).toBe(false);
    // The login response value comes from the DB (not hard-coded true): set false first, then log in.
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ id: u.id, autoVersions: false });
  });
});

describe("group switch PATCH /api/groups/:id", () => {
  it("manageGroup only; autoVersions alone is fine; empty body 400; GroupDto and GET /api/groups carry autoVersions; POST /api/groups still accepts only name", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, member.id, { autoVersions: false })).statusCode).toBe(403);
    const r = await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, { autoVersions: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: g.id, name: "G", autoVersions: false });
    expect((await db.select({ a: groups.autoVersions }).from(groups).where(eq(groups.id, g.id)))[0]!.a).toBe(false);
    // PATCH false first, then GET: if the list did not select this column (filled with default true) it could be told apart only after turning it off.
    expect((await call(app, "GET", "/api/groups", member.id)).json()[0]).toMatchObject({ id: g.id, autoVersions: false });
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, {})).statusCode).toBe(400);
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, { name: "G2", autoVersions: true })).json()).toMatchObject({ name: "G2", autoVersions: true });
    expect((await call(app, "GET", "/api/groups", member.id)).json()[0]).toMatchObject({ id: g.id, autoVersions: true });
    expect((await call(app, "POST", "/api/groups", admin.id, { name: "H", autoVersions: false })).statusCode).toBe(400);
  });
});
