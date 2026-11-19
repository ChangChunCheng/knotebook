import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Role } from "@knotebook/shared";
import { NOTE_SCHEMA_VERSION, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig, signTestSession, testSessionId } from "./helpers.js";
import { noteShares, notes, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { verifyCollabToken } from "../src/collab/token.js";

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string; tokenVersion: number }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      tokenVersion: overrides.tokenVersion ?? 0,
    })
    .returning();
  return u;
}

async function cookieFor(userId: string, tv = 0): Promise<string> {
  return signTestSession({ userId, tv });
}

describe("POST /api/notes/:id/collab-token", () => {
  it("owner/editor/viewer each get the matching role, body.role is consistent with the claims inside the token", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct1@example.com" });
    const editor = await insertUser(db, { email: "editor-ct1@example.com" });
    const viewer = await insertUser(db, { email: "viewer-ct1@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const cases: Array<{ user: { id: string }; role: Role }> = [
      { user: owner, role: "owner" },
      { user: editor, role: "editor" },
      { user: viewer, role: "viewer" },
    ];

    for (const { user, role } of cases) {
      const cookie = await cookieFor(user.id);
      const res = await app.inject({
        method: "POST",
        url: `/api/notes/${note.id}/collab-token`,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(["role", "token"]);
      expect(body.role).toBe(role);
      expect(typeof body.token).toBe("string");

      const claims = await verifyCollabToken(testConfig.appSecret, body.token);
      expect(claims).toEqual({ noteId: note.id, userId: user.id, role, tv: 0, sid: testSessionId(user.id), sv: 0 });
    }
  });

  it("session but no permission (stranger) -> 200 + role:'none' (never 403/404, the key contract)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct2@example.com" });
    const stranger = await insertUser(db, { email: "stranger-ct2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/collab-token`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe("none");
    const claims = await verifyCollabToken(testConfig.appSecret, body.token);
    expect(claims?.role).toBe("none");
  });

  it("nonexistent note (valid UUID format) -> 200 + role:'none'", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db, { email: "user-ct3@example.com" });
    const cookie = await cookieFor(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/collab-token",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("none");
  });

  it("not signed in -> 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token` });
    expect(res.statusCode).toBe(401);
  });

  it("disabled account -> 401 (blocked automatically by gate.check, not decided by this endpoint)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct5@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    // Create the note directly (not via HTTP): avoid first calling authenticate, which would make UserGate cache the "not disabled" row (TTL 60s) - then even after
    // disabledAt is written to the DB this user would keep hitting the cache and be judged "not disabled" for the rest of the test, the 401 assertion would fail,
    // and for a reason unrelated to what this test verifies ("gate.check blocks disabled accounts") (cache semantics, not a bug). In production the admin disable endpoint
    // calls `gate.invalidate` to clear the cache immediately; "never looked up" achieves the equivalent here without rebuilding an admin route harness.
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/collab-token`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token version mismatch (e.g. an old cookie after a password change) -> 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct6@example.com", tokenVersion: 5 });
    const staleCookie = await cookieFor(owner.id, 0);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/collab-token",
      cookies: { [SESSION_COOKIE]: staleCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("61st request -> 429 too_many_requests, body has no retryAfterMs (per-user 60/minute throttle)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct7@example.com" });
    const cookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    const note = createRes.json();

    let last;
    for (let i = 0; i < 61; i++) {
      last = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token`, cookies: { [SESSION_COOKIE]: cookie } });
    }
    expect(last!.statusCode).toBe(429);
    const body = last!.json();
    expect(body).toEqual({ error: { code: "too_many_requests", message: expect.any(String) } });
    expect(body.retryAfterMs).toBeUndefined();
  });

  it("#240 token signed from an uppercase id: claims.noteId is lowercase", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-r6@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id.toUpperCase()}/collab-token`, cookies: { [SESSION_COOKIE]: cookie } });
    const claims = await verifyCollabToken(testConfig.appSecret, res.json().token);
    expect(claims?.noteId).toBe(note.id);
    expect(res.statusCode).toBe(200);
  });

  it("#269: the body's noteSchemaVersion is signed into sv; no body => sv=0 (both 200, the no-leak contract is unchanged)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-sv@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const withBody = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token`, cookies: { [SESSION_COOKIE]: cookie }, payload: { noteSchemaVersion: NOTE_SCHEMA_VERSION } });
    expect(withBody.statusCode).toBe(200);
    expect((await verifyCollabToken(testConfig.appSecret, withBody.json().token))?.sv).toBe(NOTE_SCHEMA_VERSION);
    const bare = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(bare.statusCode).toBe(200);
    expect((await verifyCollabToken(testConfig.appSecret, bare.json().token))?.sv).toBe(0);
  });
});
