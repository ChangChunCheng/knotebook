/** Times are always compared on the DB clock. */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { LAST_ACTIVE_WRITE_INTERVAL_MS, NOTE_SCHEMA_VERSION, YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { UserGate } from "../src/auth/session.js";
import { signCollabToken } from "../src/collab/token.js";
import { buildCollabTestApp, buildTestApp, insertPasswordUser, testConfig, testSessionId } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

const PW = "correct-horse-battery-staple";

async function dbNow(db: Db): Promise<string> {
  return (await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`)).rows[0]!.t;
}
async function lastActiveText(db: Db, userId: string): Promise<string | null> {
  return (await db.execute<{ t: string | null }>(sql`select last_active_at::text as t from users where id = ${userId}`)).rows[0]!.t;
}
async function activeSince(db: Db, userId: string, t0: string): Promise<boolean> {
  return (await db.execute<{ ok: boolean }>(sql`select coalesce(last_active_at >= ${t0}::timestamptz, false) as ok from users where id = ${userId}`)).rows[0]!.ok;
}
async function setActiveSecondsAgo(db: Db, userId: string, seconds: number): Promise<string> {
  return (await db.execute<{ t: string }>(
    sql`update users set last_active_at = now() - make_interval(secs => ${seconds}) where id = ${userId} returning last_active_at::text as t`,
  )).rows[0]!.t;
}

// The collab touch isn't awaited (fire-and-forget), so assertions always poll the DB within a deadline.
async function waitUntil(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("users.last_active_at (#267)", () => {
  it("session-cookie requests (the session paths of authenticate and authenticateTokenOrSession) write; requests without a session don't", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const v = await seedUser(db);
    expect(await lastActiveText(db, u.id)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    const t0 = await dbNow(db);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(v.id) })).statusCode).toBe(200);
    expect(await activeSince(db, v.id, t0)).toBe(true);
  });

  it("bearer token (PAT) requests don't write", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: bearer(token) })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBeNull();
  });

  it("in-process throttle: a second request from the same app within the write interval (1 minute) doesn't write, even though the DB value is old enough for the SQL condition to allow it", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).not.toBeNull();
    const old = await setActiveSecondsAgo(db, u.id, 600);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBe(old);
  });

  it("SQL condition as backstop: another process (new app, empty throttle table) seeing a 30-second-old value doesn't write; a 2-minute-old value does", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const recent = await setActiveSecondsAgo(db, u.id, 30);
    const other = await buildTestApp({ db, gate: new UserGate(db) });
    expect((await other.app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBe(recent);

    await setActiveSecondsAgo(db, u.id, 120);
    const third = await buildTestApp({ db, gate: new UserGate(db) });
    const t0 = await dbNow(db);
    expect((await third.app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
  });

  it("password login writes both last_login_at and last_active_at", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    const t0 = await dbNow(db);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PW } })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
    expect((await db.execute<{ same: boolean }>(sql`select last_active_at = last_login_at as same from users where id = ${u.id}`)).rows[0]!.same).toBe(true);
  });

  it("GET /api/admin/users carries lastActiveAt: an ISO string (= DB value) when set, null when never recorded; lastLoginAt is still there", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const never = await seedUser(db);
    const seen = await seedUser(db);
    await db.execute(sql`update users set last_active_at = '2026-10-01T09:12:00.123Z' where id = ${seen.id}`);
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: await cookieOf(admin.id) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; lastActiveAt: string | null; lastLoginAt: string | null }>;
    expect(rows.find(r => r.id === never.id)).toMatchObject({ lastActiveAt: null, lastLoginAt: null });
    expect(rows.find(r => r.id === seen.id)!.lastActiveAt).toBe("2026-10-01T09:12:00.123Z");
    // The admin's own request is a session activity, so lastActiveAt is a timestamp string.
    const self = rows.find(r => r.id === admin.id)!.lastActiveAt;
    expect(typeof self).toBe("string");
    expect(new Date(self!).toISOString()).toBe(self);
  });
});

describe("users.last_active_at x collab (#267)", () => {
  it("creating a collab connection writes; later document changes from that connection write too (same throttle table, only after the full interval)", async () => {
    let now = 0;
    const ctx = await buildCollabTestApp({ lastActiveOptions: { now: () => now } });
    const alice = await ctx.createUser({ email: "alice@example.com", password: PW });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PW);
    // Login itself writes (touchLastLogin): clear it and move the throttle clock past one interval, so the assertions below only measure the collab touch.
    await ctx.db.execute(sql`update users set last_active_at = null where id = ${alice.id}`);
    now += LAST_ACTIVE_WRITE_INTERVAL_MS;
    // Don't fetch the token through REST (that is a session request and would write by itself): sign a collab token directly.
    const token = await signCollabToken(testConfig.appSecret, { noteId: note.id, userId: alice.id, role: "owner", tv: 0, sid: testSessionId(alice.id), sv: NOTE_SCHEMA_VERSION });
    const client = await session.connect(note.id, { tokenOverride: token });
    await waitUntil("連線建立後 last_active_at 有值", 3_000, async () => (await lastActiveText(ctx.db, alice.id)) !== null);

    const old = await setActiveSecondsAgo(ctx.db, alice.id, 600);
    const edit = (text: string) => {
      const element = new Y.XmlElement("paragraph");
      element.insert(0, [new Y.XmlText(text)]);
      client.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
    };
    // A change inside the throttle interval doesn't write. Move the clock forward a little (still inside the interval): if throttling were bypassed, the throttle table's timestamp would become the new now.
    const stamp = ctx.collab.lastActive.lastAttemptAt(alice.id);
    expect(stamp).toBeDefined();
    now += 1_000;
    edit("within interval");
    const serverHas = (text: string) => async () => ctx.collab.hocuspocus.documents.get(note.id)?.getXmlFragment(YDOC_FRAGMENT).toString().includes(text) ?? false;
    await waitUntil("server 收到間隔內的那筆變更", 3_000, serverHas("within interval"));
    expect(ctx.collab.lastActive.lastAttemptAt(alice.id)).toBe(stamp);
    // The touch isn't awaited: give a late write time to settle; every poll in the meantime must still see the old value.
    const settleUntil = Date.now() + 500;
    while (Date.now() < settleUntil) {
      expect(await lastActiveText(ctx.db, alice.id)).toBe(old);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    now += LAST_ACTIVE_WRITE_INTERVAL_MS;
    const t0 = await dbNow(ctx.db);
    edit("after interval");
    await waitUntil("文件變更後 last_active_at 更新", 3_000, () => activeSince(ctx.db, alice.id, t0));
  });

  it("bearer-token AI writes (direct connection, onChange context carries source) don't count as activity: the throttle table stays empty, last_active_at stays NULL", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "bot-owner@example.com", password: PW });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "by token" } });
    expect(res.statusCode).toBe(201);
    const settleUntil = Date.now() + 500;
    while (Date.now() < settleUntil) {
      expect(ctx.collab.lastActive.size).toBe(0);
      expect(await lastActiveText(ctx.db, u.id)).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
});
