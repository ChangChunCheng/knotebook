import { describe, it, expect } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, withTestRoutes, signTestSession } from "./helpers.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

async function insertUser(
  db: Db,
  overrides: Partial<{ email: string; displayName: string; isAdmin: boolean; tokenVersion: number; disabledAt: Date | null }> = {}
) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
    })
    .returning();
  return u;
}

// session.test.ts has verified that flipping the payload's first character is a reliable tampering method (for the last character of base64url
// only some bits are significant, so flipping it has a tiny chance of not changing the decoded bytes and giving a false green).
function tamperToken(token: string): string {
  const [header, payload, signature] = token.split(".");
  const flipped = payload[0] === "a" ? "b" : "a";
  return `${header}.${flipped}${payload.slice(1)}.${signature}`;
}

describe("buildApp", () => {
  it("not signed in -> 401 uniform shape", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("non-JSON mutating request -> 415 with the right code", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "x", headers: { "content-type": "text/plain" } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("unknown route -> 404 uniform shape", async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/nope" })).json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("healthz needs no auth: 200 and body { ok: true }", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // The content-type guard must let body-less mutating requests through (e.g. POST /logout sends no Content-Type/body);
  // requiring application/json always would wrongly 415 every body-less mutating endpoint.
  it("mutating request without body (e.g. POST /logout without Content-Type) -> allowed, no 415", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo" });
    expect(res.statusCode).not.toBe(415);
  });

  it("bad JSON body -> 400 (not 500; the error handler must not swallow a 4xx into a 500)", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{not valid json", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("content-type text/plain;charset=application/json (CORS-safelisted bypass) -> still 415", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{}", headers: { "content-type": "text/plain;charset=application/json" } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("content-type application/json; charset=utf-8 (MIME essence matches) -> passes", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{}", headers: { "content-type": "application/json; charset=utf-8" } });
    expect(res.statusCode).not.toBe(415);
    expect(res.json()).toEqual({});
  });

  it("unknown route + mutating method + non-JSON body -> 415 (proves onRequest also applies to unmatched routes; GET /nope can't discriminate that)", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/nope", payload: "x", headers: { "content-type": "text/plain" } });
    expect(res.statusCode).toBe(415);
  });

  it("real cookie happy path: signed-in user -> 200 and request.user is correct", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: false, tokenVersion: 0 });
    const token = await signTestSession({ userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: u.id,
      email: u.email,
      handle: u.handle,
      displayName: u.displayName,
      isAdmin: false,
      mustChangePassword: false,
      hasPassword: false,
      autoVersions: true,
      avatar: null,
    });
  });

  it("tampered token -> 401", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { tokenVersion: 0 });
    const token = await signTestSession({ userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: tamperToken(token) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("gate revoked (DB disabledAt set) -> 401", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { tokenVersion: 0, disabledAt: new Date() });
    const token = await signTestSession({ userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("requireAdmin: not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/admin" });
    expect(res.statusCode).toBe(401);
  });

  it("requireAdmin: non-admin -> 403", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: false, tokenVersion: 0 });
    const token = await signTestSession({ userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/admin", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("requireAdmin: admin -> passes (200)", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: true, tokenVersion: 0 });
    const token = await signTestSession({ userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/admin", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("route throw -> 500 uniform shape, body leaks no stack", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/throw" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ error: { code: "internal" } });
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});
