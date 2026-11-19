import { describe, it, expect, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, signTestSession } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { oneTimeLinks, users } from "../src/db/schema.js";
import { captureLogs } from "./helpers/admin-auth.js";
import type { Db } from "../src/db/index.js";
import type { CollabHooks } from "../src/collab/hooks.js";
import type { AdminTestHook } from "../src/auth/admin-test-hook.js";
import { hashPassword } from "../src/auth/password.js";

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returning();
  return u;
}

async function cookieFor(userId: string, tv = 0): Promise<string> {
  return signTestSession({ userId, tv });
}

function spyCollabHooks(): CollabHooks {
  return {
    onShareChanged: vi.fn(),
    onUserRevoked: vi.fn(),
    onSessionRevoked: vi.fn(),
    onGroupAccessChanged: vi.fn(),
    beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
    onNotesRestored: vi.fn(),
    linkSyncGate: () => ({ ok: false as const }),
  };
}

const EXPECTED_KEYS = ["id", "email", "handle", "displayName", "isAdmin", "disabledAt", "createdAt", "lastLoginAt", "lastActiveAt", "storage", "hasPassword", "passwordResetExpiresAt", "avatar"].sort();

describe("requireAdmin guard: every endpoint is 403 for non-admin, 401 when not signed in", () => {
  const endpoints: Array<{ name: string; url: (id: string) => string; method: "GET" | "POST" | "DELETE" }> = [
    { name: "GET /api/admin/users", method: "GET", url: () => "/api/admin/users" },
    { name: "POST /api/admin/users/:id/disable", method: "POST", url: id => `/api/admin/users/${id}/disable` },
    { name: "POST /api/admin/users/:id/enable", method: "POST", url: id => `/api/admin/users/${id}/enable` },
    { name: "POST /api/admin/users/:id/promote", method: "POST", url: id => `/api/admin/users/${id}/promote` },
    { name: "POST /api/admin/users/:id/demote", method: "POST", url: id => `/api/admin/users/${id}/demote` },
    { name: "POST /api/admin/users/:id/password-reset", method: "POST", url: id => `/api/admin/users/${id}/password-reset` },
    { name: "DELETE /api/admin/users/:id/password-reset", method: "DELETE", url: id => `/api/admin/users/${id}/password-reset` },
    { name: "POST /api/admin/invites", method: "POST", url: () => "/api/admin/invites" },
    { name: "GET /api/admin/invites", method: "GET", url: () => "/api/admin/invites" },
    { name: "DELETE /api/admin/invites/:id", method: "DELETE", url: id => `/api/admin/invites/${id}` },
  ];

  for (const ep of endpoints) {
    it(`${ep.name}: non-admin -> 403`, async () => {
      const { app, db } = await buildTestApp();
      const nonAdmin = await insertUser(db, { email: `nonadmin-${ep.name}@example.com` });
      const target = await insertUser(db, { email: `target-${ep.name}@example.com` });
      const cookie = await cookieFor(nonAdmin.id);

      const res = await app.inject({ method: ep.method, url: ep.url(target.id), cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode).toBe(403);
    });

    it(`${ep.name}: not signed in -> 401`, async () => {
      const { app, db } = await buildTestApp();
      const target = await insertUser(db, { email: `target2-${ep.name}@example.com` });

      const res = await app.inject({ method: ep.method, url: ep.url(target.id) });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("GET /api/admin/users", () => {
  it("exact shape lock (Object.keys) + no leak of passwordHash/tokenVersion", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-shape@example.com" });
    const other = await insertUser(db, { email: "other-shape@example.com", displayName: "Other" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
    }
    const otherRow = body.find((u: { id: string }) => u.id === other.id);
    expect(otherRow).toMatchObject({ id: other.id, email: "other-shape@example.com", displayName: "Other", isAdmin: false, disabledAt: null, hasPassword: true, passwordResetExpiresAt: null });
  });

  it("sorted by createdAt asc", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-order@example.com", createdAt: new Date("2026-01-01T00:00:00Z") });
    const second = await insertUser(db, { email: "second-order@example.com", createdAt: new Date("2026-01-02T00:00:00Z") });
    const third = await insertUser(db, { email: "third-order@example.com", createdAt: new Date("2026-01-03T00:00:00Z") });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((u: { id: string }) => u.id);
    expect(ids).toEqual([admin.id, second.id, third.id]);
  });
});

describe("POST /api/admin/users (#285 the create-on-behalf endpoint was removed)", () => {
  it("admin POSTing any body to /api/admin/users -> 404 (route doesn't exist, not 400/405)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-rm1@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "newuser-rm1@example.com", password: "a-strong-password", displayName: "New User" },
    });
    expect(res.statusCode).toBe(404);
    const [row] = await db.select().from(users).where(eq(users.email, "newuser-rm1@example.com"));
    expect(row).toBeUndefined();
  });
});

describe("POST /api/admin/users/:id/disable", () => {
  it("the user's existing sessions are invalidated immediately (me -> 401, no TTL wait); login -> 403 account_disabled; onUserRevoked is called", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d1@example.com" });
    const target = await insertUser(db, { email: "target-d1@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-d1@example.com", password: VALID_PASSWORD },
    });
    expect(targetLogin.statusCode).toBe(200);
    const targetCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const beforeMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(beforeMe.statusCode).toBe(200);

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    const afterMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(afterMe.statusCode).toBe(401);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-d1@example.com", password: VALID_PASSWORD },
    });
    expect(loginRes.statusCode).toBe(403);
    expect(loginRes.json()).toMatchObject({ error: { code: "account_disabled" } });

    expect(collabHooks.onUserRevoked).toHaveBeenCalledWith(target.id);
    expect(collabHooks.onUserRevoked).toHaveBeenCalledTimes(1);
  });

  it("disabling oneself -> 400 cannot_disable_self; onUserRevoked not called", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${admin.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();
  });

  it("disabling oneself (uppercase UUID) -> still 400 cannot_disable_self (case can't bypass the self-lockout check)", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d2b@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${admin.id.toUpperCase()}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();

    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row.disabledAt).toBeNull();
    expect(row.tokenVersion).toBe(0);
  });

  it("non-UUID/nonexistent -> 404 user_not_found; onUserRevoked not called", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d3@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const resInvalid = await app.inject({
      method: "POST",
      url: "/api/admin/users/not-a-uuid/disable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(resInvalid.statusCode).toBe(404);
    expect(resInvalid.json()).toMatchObject({ error: { code: "user_not_found" } });

    const resMissing = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/disable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(resMissing.statusCode).toBe(404);
    expect(resMissing.json()).toMatchObject({ error: { code: "user_not_found" } });

    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();
  });

  it("repeated disable -> 204 idempotent, tv doesn't increase again (DB assertion)", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d4@example.com" });
    const target = await insertUser(db, { email: "target-d4@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(first.statusCode).toBe(204);

    const [afterFirst] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterFirst.tokenVersion).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(second.statusCode).toBe(204);

    const [afterSecond] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterSecond.tokenVersion).toBe(1);

    // State unchanged (already disabled): the hook isn't called again - a second disable must not trigger onUserRevoked once more
    // (keep the single call from the first successful disable).
    expect(collabHooks.onUserRevoked).toHaveBeenCalledTimes(1);
  });

  // #286: disable and revoking the reset link happen in one transaction; the log is written only when revoked > 0.
  const REVOKE_LOG = "停用帳號時撤銷重設密碼連結";

  async function disableSetup() {
    const cap = captureLogs();
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() }, cap.options);
    const admin = await insertUser(db, { isAdmin: true });
    const target = await insertUser(db);
    const adminCookies = { [SESSION_COOKIE]: await cookieFor(admin.id) };
    return { app, db, admin, target, adminCookies, lines: cap.lines };
  }

  it("valid link -> disable 204 revokes it and logs; after re-enable the link stays revoked and the list shows null", async () => {
    const { app, db, admin, target, adminCookies, lines } = await disableSetup();
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/password-reset`, cookies: adminCookies, payload: { expiresInHours: 1 } });
    expect(issued.statusCode).toBe(201);

    const res = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies });
    expect(res.statusCode).toBe(204);
    const [link] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.targetUserId, target.id));
    expect(link!.revokedAt).not.toBeNull();
    expect(link!.usedAt).toBeNull();
    expect(lines.filter(l => l.msg === REVOKE_LOG).map(l => l.obj)).toEqual([{ userId: admin.id, targetUserId: target.id, revoked: 1 }]);

    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/enable`, cookies: adminCookies })).statusCode).toBe(204);
    const [after] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, link!.id));
    expect(after!.revokedAt).not.toBeNull();
    const list = await app.inject({ method: "GET", url: "/api/admin/users", cookies: adminCookies });
    expect(list.json().find((u: { id: string }) => u.id === target.id)).toMatchObject({ disabledAt: null, passwordResetExpiresAt: null });
  });

  it("no link -> disable 204, no revoke log", async () => {
    const { app, target, adminCookies, lines } = await disableSetup();
    const res = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies });
    expect(res.statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toEqual([]);
  });

  it("disabling an already disabled user (idempotent 204) -> no revoke log again", async () => {
    const { app, target, adminCookies, lines } = await disableSetup();
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/password-reset`, cookies: adminCookies, payload: { expiresInHours: 1 } });
    expect(issued.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies })).statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies })).statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toHaveLength(1);
  });
});

describe("POST /api/admin/users/:id/enable", () => {
  it("after clearing disabledAt the user can log in again; the old session (signed before disable) is still 401 (tv was bumped, not restored)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e1@example.com" });
    const target = await insertUser(db, { email: "target-e1@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e1@example.com", password: VALID_PASSWORD },
    });
    const oldCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    const enableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/enable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(enableRes.statusCode).toBe(204);

    const loginAfterEnable = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e1@example.com", password: VALID_PASSWORD },
    });
    expect(loginAfterEnable.statusCode).toBe(200);

    const meOld = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(meOld.statusCode).toBe(401);
  });

  it("a stale disabled state in the gate cache must not be reused: seed a revoked cache entry before disable, after enable a new session still gets 200 (pins the gate.invalidate call so it can't be silently removed)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e3@example.com" });
    const target = await insertUser(db, { email: "target-e3@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e3@example.com", password: VALID_PASSWORD },
    });
    const oldCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    // Calling me with the old cookie -> 401 also loads the "disabledAt set" row into the gate cache (TTL 60s) - a cache write that disable's own
    // gate.invalidate already handled; the stale entry must be cleared by enable's gate.invalidate, not disable's.
    const staleMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(staleMe.statusCode).toBe(401);

    const enableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/enable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(enableRes.statusCode).toBe(204);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e3@example.com", password: VALID_PASSWORD },
    });
    expect(newLogin.statusCode).toBe(200);
    const newCookie = newLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    // If enable didn't call gate.invalidate, the stale cache entry (disabledAt still non-null) would be reused here and even a session from a fresh login
    // would be wrongly judged 401 (without waiting for the 60s TTL).
    const meAfterEnable = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie } });
    expect(meAfterEnable.statusCode).toBe(200);
  });

  it("nonexistent -> 404 user_not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/enable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "user_not_found" } });
  });
});

describe("POST /api/admin/users/:id/promote", () => {
  it("isAdmin=true; the user can call admin APIs immediately (no TTL wait; gate.invalidate takes effect)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p1@example.com" });
    const target = await insertUser(db, { email: "target-p1@example.com" });
    const adminCookie = await cookieFor(admin.id);
    const targetCookie = await cookieFor(target.id, 0);

    const beforeRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(beforeRes.statusCode).toBe(403);

    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/promote`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(promoteRes.statusCode).toBe(204);

    const afterRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(afterRes.statusCode).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row.isAdmin).toBe(true);
  });

  it("nonexistent -> 404 user_not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/promote",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "user_not_found" } });
  });
});

/** Number of these users who are still enabled admins (counts only users seeded by this case; unaffected by other rows). */
async function enabledAdminsAmong(db: Db, ids: string[]): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.isAdmin, true), isNull(users.disabledAt)));
  return rows.length;
}
const demote = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], targetId: string, cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: `/api/admin/users/${targetId}/demote`, cookies });

describe("POST /api/admin/users/:id/demote (#247)", () => {
  it("success 204, DB is_admin=false; the demoted user calling an admin API right after -> 403 (gate.invalidate, no 60 s cache wait)", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const bCookies = await cookieOf(b.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: bCookies })).statusCode).toBe(200); // fills the gate cache
    const res = await demote(app, b.id, await cookieOf(a.id));
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: bCookies })).statusCode).toBe(403);
    expect(res.statusCode).toBe(204);
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, b.id));
    expect(row!.isAdmin).toBe(false);
  });

  it("demoting oneself (lowercase and uppercase UUID) -> 400 cannot_demote_self; still admin", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    await seedUser(db, { isAdmin: true }); // another admin exists: proves it's blocked because the target is oneself, not because it's the last one
    for (const id of [a.id, a.id.toUpperCase()]) {
      const r = await demote(app, id, await cookieOf(a.id));
      expect(r.statusCode, id).toBe(400);
      expect(r.json().error, id).toEqual({ code: "cannot_demote_self", message: "You can't remove your own admin role." });
    }
    expect(await enabledAdminsAmong(db, [a.id])).toBe(1);
  });

  it("nonexistent/non-UUID -> 404 user_not_found; not an admin to begin with -> 204 idempotent, still not an admin", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const plain = await seedUser(db);
    const cookies = await cookieOf(a.id);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      const r = await demote(app, id, cookies);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().error.code, id).toBe("user_not_found");
    }
    expect((await demote(app, plain.id, cookies)).statusCode).toBe(204);
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, plain.id));
    expect(row!.isAdmin).toBe(false);
  });

  it("sequence: caller already demoted but the gate cache still says admin -> demoting the only admin gives 409 last_site_admin (not the group's last_admin), nothing written", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const aCookies = await cookieOf(a.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: aCookies })).statusCode).toBe(200); // fills a's cache
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, a.id)); // bypass the endpoint without invalidating: a's cache still says admin
    const r = await demote(app, b.id, aCookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({ code: "last_site_admin", message: "The site needs at least one active admin." });
    expect(await enabledAdminsAmong(db, [a.id, b.id])).toBe(1);
  });

  it("sequence, disabled form: caller already disabled but cache still valid -> only the target is left as an enabled admin -> 409; a disabled admin doesn't count", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const aCookies = await cookieOf(a.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: aCookies })).statusCode).toBe(200);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.id));
    const r = await demote(app, b.id, aCookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("last_site_admin");
  });

  it("concurrent mutual demotion (test-hook interleaving): while A's demote of B holds the lock without having written, B demoting A blocks on the lock; exactly one 204 and one 409 last_site_admin; one enabled admin remains", async () => {
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: AdminTestHook = async point => {
      if (point !== "demote-locked" || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ adminTestHook: hook });
    const a = await seedUser(built.db, { isAdmin: true });
    const b = await seedUser(built.db, { isAdmin: true });
    const bCookies = await cookieOf(b.id);
    race.fire = () => demote(built.app, a.id, bCookies);
    const first = await demote(built.app, b.id, await cookieOf(a.id));
    const other = await second!;
    expect(interleave).toBe("blocked");
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_site_admin");
    expect(await enabledAdminsAmong(built.db, [a.id, b.id])).toBe(1);
  });

  it("disabled_at concurrency: C is a disabled admin; A and B demote each other at once -> exactly one 204 and one 409 (count only includes enabled admins, C doesn't count)", async () => {
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: AdminTestHook = async point => {
      if (point !== "demote-locked" || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ adminTestHook: hook });
    const a = await seedUser(built.db, { isAdmin: true });
    const b = await seedUser(built.db, { isAdmin: true });
    const c = await seedUser(built.db, { isAdmin: true, disabled: true });
    const bCookies = await cookieOf(b.id);
    race.fire = () => demote(built.app, a.id, bCookies);
    const first = await demote(built.app, b.id, await cookieOf(a.id));
    const other = await second!;
    expect(interleave).toBe("blocked");
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect(await enabledAdminsAmong(built.db, [a.id, b.id, c.id])).toBe(1);
  });
});

/** Shape of the #286 link-generation transaction: the link row carries created_by_id (the FK check takes KEY SHARE on the creator's users row). */
const RESET_LINK_SQL =
  "insert into one_time_links (kind, token_hash, target_user_id, created_by_id, expires_at) values ('password_reset', 'h-' || gen_random_uuid(), $1, $2, now() + interval '1 hour')";
async function insertResetLink(db: Db, targetId: string, createdById: string): Promise<void> {
  await db.$client.query(RESET_LINK_SQL, [targetId, createdById]);
}

const disableUser = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], targetId: string, cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: `/api/admin/users/${targetId}/disable`, cookies });

describe("POST /api/admin/users/:id/disable: the last enabled admin (#250)", () => {
  it("sequence: target is the only enabled admin (caller already disabled but cache still valid) -> 409 last_site_admin; data unchanged, reset link not revoked", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    await insertResetLink(db, b.id, a.id);
    const aCookies = await cookieOf(a.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: aCookies })).statusCode).toBe(200); // fills a's cache
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.id)); // bypass the endpoint, no invalidate
    const r = await disableUser(app, b.id, aCookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({ code: "last_site_admin", message: "The site needs at least one active admin." });
    const [row] = await db.select({ disabledAt: users.disabledAt, tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, b.id));
    expect(row).toEqual({ disabledAt: null, tokenVersion: 0 });
    const [link] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.targetUserId, b.id));
    expect(link!.revokedAt).toBeNull();
  });

  it("normal: two enabled admins, disabling one -> 204; disabling a non-admin is unaffected; disabling an already disabled admin again is idempotent 204", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const plain = await seedUser(db);
    const aCookies = await cookieOf(a.id);
    expect((await disableUser(app, b.id, aCookies)).statusCode).toBe(204);
    expect(await enabledAdminsAmong(db, [a.id, b.id])).toBe(1);
    expect((await disableUser(app, plain.id, aCookies)).statusCode).toBe(204);
    expect((await disableUser(app, b.id, aCookies)).statusCode).toBe(204);
  });

  it("concurrent mutual disable (raw client holds the lock first): A disables B and B disables A both block on the lock; after release exactly one 204 and one 409; one enabled admin remains", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const aCookies = await cookieOf(a.id);
    const bCookies = await cookieOf(b.id);
    const raw = await db.$client.connect();
    let released = false;
    try {
      await raw.query("begin");
      await raw.query("select id from users where is_admin = true and disabled_at is null for update");
      const p1 = disableUser(app, b.id, aCookies);
      await waitForLockWaiters(db.$client, 1);
      const p2 = disableUser(app, a.id, bCookies);
      await waitForLockWaiters(db.$client, 2);
      await raw.query("commit");
      released = true;
      const [r1, r2] = await Promise.all([p1, p2]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([204, 409]);
      expect([r1, r2].find(r => r.statusCode === 409)!.json().error.code).toBe("last_site_admin");
      expect(await enabledAdminsAmong(db, [a.id, b.id])).toBe(1);
    } finally {
      if (!released) await raw.query("rollback").catch(() => {});
      raw.release();
    }
  });

  it("concurrent with link generation, no deadlock: the link transaction locks the target row first, disable blocks on the target row, the link INSERT takes KEY SHARE on the creator -> both succeed (no 500/40P01)", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const p = await seedUser(db);
    const raw = await db.$client.connect();
    try {
      await raw.query("begin");
      await raw.query("select id from users where id = $1 for no key update", [p.id]);
      const pending = disableUser(app, p.id, await cookieOf(b.id));
      await waitForLockWaiters(db.$client, 1);
      await raw.query(RESET_LINK_SQL, [p.id, a.id]);
      await raw.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await raw.query("rollback").catch(() => {});
      raw.release();
    }
  });

  it("concurrent with link generation, no deadlock (demote form): link target X is an admin whose id is larger than the creator's, demoted at the same time -> both succeed", async () => {
    const { app, db } = await buildTestApp();
    const [lo, mid, hi] = [await seedUser(db, { isAdmin: true }), await seedUser(db, { isAdmin: true }), await seedUser(db, { isAdmin: true })].sort((x, y) => (x.id < y.id ? -1 : 1));
    const raw = await db.$client.connect();
    try {
      await raw.query("begin");
      await raw.query("select id from users where id = $1 for no key update", [hi!.id]);
      const pending = demote(app, hi!.id, await cookieOf(mid!.id));
      await waitForLockWaiters(db.$client, 1);
      await raw.query(RESET_LINK_SQL, [hi!.id, lo!.id]);
      await raw.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await raw.query("rollback").catch(() => {});
      raw.release();
    }
  });

  for (const order of ["demote-first", "disable-first"] as const) {
    it(`disable x demote mutual exclusion under concurrency (${order}): raw client holds the lock first, exactly one 204 and one 409; one enabled admin remains`, async () => {
      const { app, db } = await buildTestApp();
      const a = await seedUser(db, { isAdmin: true });
      const b = await seedUser(db, { isAdmin: true });
      const aCookies = await cookieOf(a.id);
      const bCookies = await cookieOf(b.id);
      const raw = await db.$client.connect();
      let released = false;
      try {
        await raw.query("begin");
        await raw.query("select id from users where is_admin = true for update");
        const fireDemote = () => demote(app, b.id, aCookies);
        const fireDisable = () => disableUser(app, a.id, bCookies);
        const first = order === "demote-first" ? fireDemote() : fireDisable();
        await waitForLockWaiters(db.$client, 1);
        const second = order === "demote-first" ? fireDisable() : fireDemote();
        await waitForLockWaiters(db.$client, 2);
        await raw.query("commit");
        released = true;
        const results = await Promise.all([first, second]);
        expect(results.map(r => r.statusCode).sort()).toEqual([204, 409]);
        expect(results.find(r => r.statusCode === 409)!.json().error.code).toBe("last_site_admin");
        expect(await enabledAdminsAmong(db, [a.id, b.id])).toBe(1);
      } finally {
        if (!released) await raw.query("rollback").catch(() => {});
        raw.release();
      }
    });
  }
});
