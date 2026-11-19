// `freshDb()`'s test trigger creates a "test default session" row per user (`testSessionId`, see helpers.ts). When counting
// rows, count only the rows created by this login (`sidOf(cookie)`) or say explicitly that the default row is included.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { eq, sql } from "drizzle-orm";
import { COLLAB_CLOSE_REVOKED, SESSION_COOKIE, type Role } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { COLLAB_REJECT_INVALID_TOKEN } from "../src/collab/server.js";
import { insertSession } from "../src/auth/sessions.js";
import { signSession } from "../src/auth/session.js";
import { sessions, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { spyCollabHooks } from "./group-helpers.js";
import { hashPassword } from "../src/auth/password.js";
import {
  buildCollabTestApp,
  buildTestApp,
  COLLAB_TOKEN_INIT,
  insertPasswordUser,
  signTestSession,
  TEST_SESSION_TTL,
  testConfig,
  testSessionId,
  type HttpSession,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-388";

async function login(app: App, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
}

async function me(app: App, cookie: string): Promise<number> {
  return (await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } })).statusCode;
}

async function logout(app: App, cookie?: string): Promise<{ status: number; cleared: boolean }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/logout", ...(cookie !== undefined ? { cookies: { [SESSION_COOKIE]: cookie } } : {}) });
  const c = res.cookies.find(one => one.name === SESSION_COOKIE);
  return { status: res.statusCode, cleared: c?.value === "" && c.maxAge === 0 };
}

const sidOf = (jwt: string): string => decodeJwt(jwt).sid as string;

async function sessionIdsOf(db: Db, userId: string): Promise<string[]> {
  return (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).map(r => r.id).sort();
}

/** Same derivation as `sessionKey` in `auth/session.ts`; used to sign pre-upgrade JWTs (no sid). */
function sessionKey(): Uint8Array {
  return createHash("sha256").update(`${testConfig.appSecret}:session`).digest();
}

describe("#388 logout invalidates only this device", () => {
  it("same account on two devices: A logs out -> A's old cookie 401 and row deleted; B still 200 and row kept", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    expect(sidOf(a)).not.toBe(sidOf(b));
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a), sidOf(b), testSessionId(u.id)].sort());

    // Hit each once first to warm the gate's session cache: logout must take effect at once, not after the 60 s TTL.
    expect(await me(app, a)).toBe(200);
    expect(await me(app, b)).toBe(200);

    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await me(app, a)).toBe(401); // a copied cookie cannot get in either
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b), testSessionId(u.id)].sort());
  });

  it("idempotent: no cookie, garbage string, or an already logged-out cookie all give 204 and clear the cookie; no row is touched", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    expect(await logout(app)).toEqual({ status: 204, cleared: true });
    expect(await logout(app, "not-a-jwt")).toEqual({ status: 204, cleared: true });
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b), testSessionId(u.id)].sort());
  });

  it("DB error on the row delete: still 204 plus cookie cleared (not stuck logged in)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    // Make the DELETE fail by renaming the table (verifySession does not touch the DB, so only the row delete fails).
    await db.execute(sql`alter table sessions rename to sessions_hidden`);
    try {
      expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    } finally {
      await db.execute(sql`alter table sessions_hidden rename to sessions`);
    }
    // Known cost (pinned as is): the row is not deleted, so a copy of this cookie stays usable until it expires; this browser's cookie is cleared.
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a), testSessionId(u.id)].sort());
  });

  it("logging in again on the same browser without logging out: the old cookie's row is deleted (copies die); other devices of the account are unaffected", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: a }, payload: { email: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a)).toBe(401);
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a2), sidOf(b), testSessionId(u.id)].sort());
  });

  it("browser carries another account V's cookie when logging in: V's row is untouched (#187)", async () => {
    const { app, db } = await buildTestApp();
    const v = await insertPasswordUser(db);
    const u = await insertPasswordUser(db);
    const vCookie = await login(app, v.email);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: vCookie }, payload: { email: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(await me(app, vCookie)).toBe(200);
    expect(await sessionIdsOf(db, v.id)).toEqual([sidOf(vCookie), testSessionId(v.id)].sort());
  });

  it("cookie whose row is already gone: neither logout nor re-login triggers re-verification (only an actual row delete clears the cache, re-verifies and schedules the delayed re-verify)", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, reloginReverifyDelayMs: 50 });
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(1); // the one that really deleted a row
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    const relogin = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: a }, payload: { email: u.email, password: PASSWORD } });
    expect(relogin.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(1);
    // Contrast: re-login with an old cookie whose row still exists re-verifies once after the delay.
    const b = relogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const again = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: b }, payload: { email: u.email, password: PASSWORD } });
    expect(again.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(2);
    expect(hooks.onSessionRevoked).toHaveBeenLastCalledWith(u.id, sidOf(b));
  });

  it("JWT signed with another key but whose sid points at someone else's row: logout does not delete that row", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const b = await login(app, u.email);
    const forged = await signSession("f".repeat(64), { userId: u.id, tv: 0, sid: sidOf(b) }, TEST_SESSION_TTL);
    expect(await logout(app, forged)).toEqual({ status: 204, cleared: true });
    expect(await me(app, b)).toBe(200);
  });
});

describe("#388 old-format and invalid JWTs", () => {
  it("pre-upgrade JWT (valid signature and tv, but no sid) -> 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const legacy = await new SignJWT({ tv: 0 }).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime("7d").sign(sessionKey());
    expect(await me(app, legacy)).toBe(401);
    // Contrast: the same user signed the same way with an existing sid passes - the 401 really comes from the missing sid.
    const withSid = await new SignJWT({ tv: 0, sid: testSessionId(u.id) }).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime("7d").sign(sessionKey());
    expect(await me(app, withSid)).toBe(200);
  });

  it("sid not in uuid shape -> 401 (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const bad = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: "not-a-uuid" }, TEST_SESSION_TTL);
    expect(await me(app, bad)).toBe(401);
  });

  it("sid row belongs to another user -> 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const other = await insertPasswordUser(db);
    const cross = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: testSessionId(other.id) }, TEST_SESSION_TTL);
    expect(await me(app, cross)).toBe(401);
  });

  it("row expired (JWT itself not yet expired) -> 401; the next login cleans expired rows and leaves unexpired ones", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const sid = await insertSession(db, u.id, TEST_SESSION_TTL);
    const cookie = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid }, TEST_SESSION_TTL);
    // Contrast: another row that has not expired still works (the 401 below is caused by expiry, not by this way of signing).
    const liveSid = await insertSession(db, u.id, TEST_SESSION_TTL);
    expect(await me(app, await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: liveSid }, TEST_SESSION_TTL))).toBe(200);
    // expires_at never changes in production code (not sliding), so change the DB directly to simulate "expired"; change first, then hit, bypassing the gate's cache.
    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(sessions.id, sid));
    expect(await me(app, cookie)).toBe(401);

    const keep = await login(app, u.email); // triggers opportunistic cleanup (fire-and-forget)
    const deadline = Date.now() + 5_000;
    while ((await sessionIdsOf(db, u.id)).includes(sid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(await sessionIdsOf(db, u.id)).toEqual([liveSid, sidOf(keep), testSessionId(u.id)].sort());
  });
});

describe("#388 change password / add password / disable", () => {
  it("change password: this device gets a fresh session row and keeps working; other devices (including this one's pre-change cookie) are 401 and their rows all deleted", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: a },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, a)).toBe(401);
    expect(await me(app, b)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a2)]);
    // The old tv being bumped is only one line of defence; even with tv matched, a deleted row cannot get in.
    const bSameTv = await signSession(testConfig.appSecret, { userId: u.id, tv: (decodeJwt(a2).tv as number), sid: sidOf(b) }, TEST_SESSION_TTL);
    expect(await me(app, bSameTv)).toBe(401);
  });

  it("two simultaneous password changes: bump and row swap are one transaction -> the earlier writer's bump does not commit before its row swap; the later writer stays logged in and the earlier one is logged out", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const change = (cookie: string, newPassword: string) =>
      app.inject({ method: "POST", url: "/api/auth/password", cookies: { [SESSION_COOKIE]: cookie }, payload: { currentPassword: PASSWORD, newPassword } });
    const pool = db.$client;
    const lockWaiters = async () =>
      Number((await pool.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0].n);
    const until = async (label: string, check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
        await new Promise(r => setTimeout(r, 20));
      }
    };
    // Lock this account's session rows first: A's row swap stalls on DELETE and B comes in after.
    const holder = await pool.connect();
    let pa: ReturnType<typeof change> | undefined;
    let pb: ReturnType<typeof change> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from sessions where user_id = $1 for update", [u.id]);
      pa = change(a, "first-new-password-388");
      await until("A 卡在 session 列鎖上", async () => (await lockWaiters()) === 1);
      pb = change(b, "second-new-password-388");
      await until("B 也在等鎖", async () => (await lockWaiters()) === 2);
      // Evidence of one transaction: A has bumped but not committed (holding the users row lock while waiting on the session rows) and B queues on
      // the users row lock - the committed tv is still 0. Were it two steps, this would be 2 (both bumps committed, both stuck on the row swap).
      expect((await pool.query("select token_version from users where id = $1", [u.id])).rows[0].token_version).toBe(0);
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    const [ra, rb] = await Promise.all([pa!, pb!]);
    expect(ra.statusCode).toBe(204);
    expect(rb.statusCode).toBe(204);
    const a2 = ra.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const b2 = rb.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, b2)).toBe(200);
    expect(await me(app, a2)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b2)]);
    expect((await pool.query("select token_version from users where id = $1", [u.id])).rows[0].token_version).toBe(2);
    await login(app, u.email, "second-new-password-388");
  });

  it("add password (SSO-only account): this device gets a fresh row; other devices' rows all deleted", async () => {
    const { app, db } = await buildTestApp();
    const [u] = await db.insert(users).values({ email: "sso-388@example.com", displayName: "S", passwordHash: null }).returning();
    const sidA = await insertSession(db, u!.id, TEST_SESSION_TTL);
    const sidB = await insertSession(db, u!.id, TEST_SESSION_TTL);
    const a = await signSession(testConfig.appSecret, { userId: u!.id, tv: 0, sid: sidA }, TEST_SESSION_TTL);
    const b = await signSession(testConfig.appSecret, { userId: u!.id, tv: 0, sid: sidB }, TEST_SESSION_TTL);
    const res = await app.inject({ method: "POST", url: "/api/auth/password/set", cookies: { [SESSION_COOKIE]: a }, payload: { newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(204);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, b)).toBe(401);
    expect(await sessionIdsOf(db, u!.id)).toEqual([sidOf(a2)]);
  });

  it("set a new password via a reset link: this device gets a fresh row; other devices' rows all deleted and cookies 401", async () => {
    const { app, db } = await buildTestApp();
    const [admin] = await db.insert(users).values({ email: "admin-388r@example.com", displayName: "A", isAdmin: true }).returning();
    const adminCookie = await signTestSession({ userId: admin!.id, tv: 0 });
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/password-reset`, cookies: { [SESSION_COOKIE]: adminCookie }, payload: { expiresInHours: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const done = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token: issued.json().token, newPassword: NEW_PASSWORD } });
    expect(done.statusCode, done.body).toBe(200);
    const fresh = done.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, fresh)).toBe(200);
    expect(await me(app, a)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(fresh)]);
  });

  it("disable account: all its session rows deleted and all cookies 401; re-enabling does not revive them; others' rows untouched", async () => {
    const { app, db } = await buildTestApp();
    const [admin] = await db.insert(users).values({ email: "admin-388@example.com", displayName: "A", isAdmin: true, passwordHash: await hashPassword(PASSWORD) }).returning();
    const adminCookie = await signTestSession({ userId: admin!.id, tv: 0 });
    const u = await insertPasswordUser(db);
    const bystander = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const c = await login(app, bystander.email);

    const dis = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/disable`, cookies: { [SESSION_COOKIE]: adminCookie } });
    expect(dis.statusCode).toBe(204);
    expect(await sessionIdsOf(db, u.id)).toEqual([]);
    expect(await me(app, a)).toBe(401);
    expect(await me(app, b)).toBe(401);

    const en = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/enable`, cookies: { [SESSION_COOKIE]: adminCookie } });
    expect(en.statusCode).toBe(204);
    expect(await me(app, a)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([]);
    expect(await me(app, c)).toBe(200);
    expect(await sessionIdsOf(db, bystander.id)).toEqual([sidOf(c), testSessionId(bystander.id)].sort());
  });
});

async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, COLLAB_TOKEN_INIT);
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）`);
  return ((await res.json()) as { token: string; role: Role }).token;
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("#388 collab connections", () => {
  const buildApp = () => buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });

  it("A logs out -> A's open collab connection is close(revoked) within 10 s; same account's B connection is unaffected (not asked to re-verify)", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const sessA = await ctx.loginAs("collab-388a@example.com", PASSWORD);
    const sessB = await ctx.loginAs("collab-388a@example.com", PASSWORD);
    const clientA = await sessA.connect(note.id);
    // How many times B fetched a token: if B were also asked to re-verify after A's logout (instead of only the connections of A's sid), this number would grow.
    let bTokenFetches = 0;
    const clientB = await sessB.connect(note.id, {
      tokenFn: async () => {
        bTokenFetches += 1;
        return fetchToken(sessB, note.id);
      },
    });
    expect(ctx.collab.connectionsOf(u.id).size).toBe(2);
    const bFetchesBefore = bTokenFetches;

    const started = Date.now();
    const out = await sessA.fetch("/api/auth/logout", { method: "POST" });
    expect(out.status).toBe(204);
    await waitFor("A 的連線被 close(knotebook:revoked)", 10_000, () => clientA.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED));
    expect(Date.now() - started).toBeLessThan(10_000);

    await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
    expect(clientB.closes).toEqual([]);
    expect(bTokenFetches).toBe(bFetchesBefore);
    await waitFor("只剩 B 的連線", 5_000, () => ctx.collab.connectionsOf(u.id).size === 1);
    expect((await sessB.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT)).status).toBe(200);
  });

  describe("re-login on the same browser (delayed re-verify)", () => {
    // Test delay: long enough that "the browser saves the new cookie 300 ms late" falls inside it; the production value is RELOGIN_REVERIFY_DELAY_MS (10 s).
    const DELAY_MS = 1_500;
    const COOKIE_STORED_AFTER_MS = 300;
    const EMAIL = (tag: string) => `collab-388-${tag}@example.com`;
    const buildDelayed = () => buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log), reloginReverifyDelayMs: DELAY_MS });
    const cookieOf = (res: Response) => res.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
    const jwtOf = (cookieHeader: string) => cookieHeader.split("=").slice(1).join("=");

    async function scene(tag: string) {
      const ctx = await buildDelayed();
      const u = await ctx.createUser({ email: EMAIL(tag), password: PASSWORD });
      const note = await ctx.createNote(u.id);
      const loginWith = (cookie?: string) =>
        fetch(`${ctx.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ email: EMAIL(tag), password: PASSWORD }),
        });
      const tokenWith = async (cookie: string): Promise<string> => {
        const r = await fetch(`${ctx.baseUrl}/api/notes/${note.id}/collab-token`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: COLLAB_TOKEN_INIT.body });
        if (!r.ok) throw new Error(`collab token ${r.status}`);
        return ((await r.json()) as { token: string }).token;
      };
      const meWith = async (cookie: string) => (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie } })).status;
      const sess = await ctx.loginAs(EMAIL(tag), PASSWORD); // only borrows the connect pipeline (its own cookie is unused)
      return { ctx, u, note, loginWith, tokenWith, meWith, sess };
    }

    it("old tab: not asked to re-verify at the moment of re-login; asked once after the delay, swaps to a new sid using the browser's new cookie, connection stays", async () => {
      const { ctx, u, note, loginWith, tokenWith, meWith, sess } = await scene("a");
      const oldCookie = cookieOf(await loginWith());
      let current = oldCookie;
      let fetches = 0;
      const client = await sess.connect(note.id, {
        tokenFn: async () => {
          fetches += 1;
          return tokenWith(current);
        },
      });
      const before = fetches;

      const relogin = await loginWith(oldCookie);
      expect(relogin.status).toBe(200);
      const newCookie = cookieOf(relogin);
      // Simulates the browser saving the new cookie a bit later: if the old tab were asked to re-verify in this window it would hit 401 with the old cookie and be kicked (the failure mode of immediate re-verification).
      await new Promise(resolve => setTimeout(resolve, COOKIE_STORED_AFTER_MS));
      expect(fetches).toBe(before);
      current = newCookie;
      expect(await meWith(oldCookie)).toBe(401);
      expect(await meWith(newCookie)).toBe(200);

      await waitFor("延遲後被要求重驗一次", DELAY_MS + 3_000, () => fetches === before + 1);
      await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
      expect(fetches).toBe(before + 1);
      expect(client.closes).toEqual([]);
      const handles = [...ctx.collab.connectionsOf(u.id)];
      expect(handles).toHaveLength(1);
      expect(handles[0]!.sessionId).toBe(sidOf(jwtOf(newCookie))); // switched to the new sid (so logging out this device later finds it)
    });

    it("connection opened with a copied old cookie: closed (revoked) within delay + re-verify deadline", async () => {
      const { note, loginWith, tokenWith, sess } = await scene("b");
      const oldCookie = cookieOf(await loginWith());
      let fetches = 0;
      const copied = await sess.connect(note.id, {
        tokenFn: () => {
          fetches += 1;
          return tokenWith(oldCookie);
        },
      });
      const before = fetches;
      expect((await loginWith(oldCookie)).status).toBe(200);
      // Whether it was the delayed re-verify and not an immediate one is judged by when the token was requested, not by close time:
      // an immediate re-verify would get 401 with the old cookie and still wait for the 5 s deadline before closing, so the close time is >= DELAY_MS either way.
      await new Promise(resolve => setTimeout(resolve, DELAY_MS / 2));
      expect(fetches).toBe(before);
      await waitFor("副本的連線被 close(knotebook:revoked)", DELAY_MS + REVERIFY_DEADLINE_MS + 3_000, () =>
        copied.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED),
      );
      expect(fetches).toBe(before + 1);
    });
  });

  it("collab token obtained before logout and not yet expired: the handshake after logout is rejected (session-revoked)", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388b@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const sess = await ctx.loginAs("collab-388b@example.com", PASSWORD);
    const token = await fetchToken(sess, note.id);
    expect((await sess.fetch("/api/auth/logout", { method: "POST" })).status).toBe(204);
    await expect(sess.connect(note.id, { tokenOverride: token })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    expect(ctx.collabLogs.some(l => l.obj.cause === "session-revoked")).toBe(true);
  });

  it("after a password change the same device's connection stays on the new sid; then logging this device out (new sid) closes the connection", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    // This device's cookie is managed here (a password change swaps the cookie, while HttpSession's cookie is fixed); HttpSession only lends its connect pipeline.
    const cookieOf = (res: Response) => res.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
    const post = (path: string, cookie: string, body?: unknown) =>
      fetch(`${ctx.baseUrl}${path}`, {
        method: "POST",
        headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const loginRes = await fetch(`${ctx.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "collab-388c@example.com", password: PASSWORD }) });
    let cookie = cookieOf(loginRes);
    let rotating = false;
    const tokenFn = async (): Promise<string> => {
      // During a password change the server asks for re-verification before the new cookie is returned: fetch the token only once the new cookie is in hand (simulates the request after the browser accepts Set-Cookie).
      while (rotating) await new Promise(resolve => setTimeout(resolve, 10));
      const r = await post(`/api/notes/${note.id}/collab-token`, cookie, { noteSchemaVersion: JSON.parse(COLLAB_TOKEN_INIT.body).noteSchemaVersion });
      if (!r.ok) throw new Error(`collab token ${r.status}`);
      return ((await r.json()) as { token: string }).token;
    };
    const sess = await ctx.loginAs("collab-388c@example.com", PASSWORD);
    const client = await sess.connect(note.id, { tokenFn });

    rotating = true;
    const changed = await post("/api/auth/password", cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(204);
    cookie = cookieOf(changed);
    rotating = false;
    await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
    expect(client.closes).toEqual([]); // re-verify got a token for the new sid and passed

    expect((await post("/api/auth/logout", cookie)).status).toBe(204);
    await waitFor("新 sid 登出後連線被 close(knotebook:revoked)", 10_000, () => client.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED));
  });
});
