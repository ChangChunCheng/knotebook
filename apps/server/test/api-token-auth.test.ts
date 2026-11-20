/**
 * Since #108 `GET /api/mcp` returns `405` (+ `Allow: POST`) after authentication passes, not 501: this file uses it as the "auth passed" sentinel
 * (405 still goes through `authenticateTokenOrSession` and the `tokenRead` charge).
 *
 * Guards three silent breakages: the `WWW-Authenticate` shape of 401/403 (MCP clients discover the authorization server through it; a missing field and the OAuth flow can't start);
 * which failures count toward BEARER_MISS and which deliberately don't; token plaintext and the `Authorization` header never reaching the log.
 */
import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { apiTokens, noteShares, notes, oauthClients, users } from "../src/db/schema.js";
import { generateAccessToken } from "../src/auth/api-token.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, freshLimiters, signTestSession } from "./helpers.js";
import { INITIALIZE, mcpPost } from "./mcp-helpers.js";

/** testConfig's PUBLIC_URL is http://localhost:3000; the issuer is its origin. */
const ISSUER = "http://localhost:3000";

function hash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Uses the product's generator (real base64url alphabet); `hash()` is deliberately not imported, kept as an independent oracle. */
function randomToken(): string {
  return generateAccessToken();
}

// Waits for the fire-and-forget UPDATE to land (bounded polling).
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function seedToken(
  db: Db,
  over: {
    scope?: "notes:read" | "notes:read notes:write" | "notes:read notes:write notes:delete";
    expiresAt?: Date | null;
    disabled?: boolean;
    mustChangePassword?: boolean;
  } = {}
): Promise<{ token: string; userId: string; tokenId: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `t-${randomUUID()}@example.com`,
      displayName: "T",
      disabledAt: over.disabled === true ? new Date() : null,
      mustChangePassword: over.mustChangePassword ?? false,
    })
    .returning();
  const token = randomToken();
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: user.id,
      kind: "pat",
      name: "test",
      scope: over.scope ?? "notes:read notes:write",
      accessTokenHash: hash(token),
      accessExpiresAt: over.expiresAt === undefined ? null : over.expiresAt,
    })
    .returning();
  return { token, userId: user.id, tokenId: row.id };
}

describe("/api/mcp method shape and Bearer challenge", () => {
  it("all three methods without credentials -> 401, challenge carries resource_metadata and four scopes, no error", async () => {
    const { app } = await buildTestApp();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/mcp", ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, method).toBe(401);
      const challenge = res.headers["www-authenticate"] as string;
      expect(challenge, method).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
      expect(challenge, method).toContain(`scope="notes:read notes:write notes:move notes:delete"`);
      expect(challenge, method).not.toContain("error=");
    }
  });

  it("valid token passes -> GET is 405 + Allow: POST (a method mismatch, not a 500 internal)", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(405);
    // #108: a MUST of RFC 9110 §15.5.6. The 405 body is JSON-RPC error shaped (see routes/mcp.ts).
    expect(res.headers.allow).toBe("POST");
    expect(res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: expect.any(String) },
    });
  });

  it("bad token -> 401 and the challenge carries error=invalid_token", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Bearer knb_nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(`error="invalid_token"`);
  });

  it("Authorization: Basic -> 401 without error (RFC 6750 section 3), and counts toward BEARER_MISS", async () => {
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Basic dXNlcjpwdw==" } });
      expect(res.statusCode, `#${i}`).toBe(401);
      expect(res.headers["www-authenticate"], `#${i}`).not.toContain("error=");
    }
    const fourth = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Basic dXNlcjpwdw==" } });
    expect(fourth.statusCode).toBe(429);
    // 429 carries no challenge (RFC 6750 challenges are only defined for 400/401/403)
    expect(fourth.headers["www-authenticate"]).toBeUndefined();
  });

  it("a knb_-prefixed token that isn't found also counts toward BEARER_MISS (not only the Basic path)", async () => {
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const bad = { authorization: `Bearer ${randomToken()}` };
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: bad })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: bad })).statusCode).toBe(401);
    const third = await app.inject({ method: "GET", url: "/api/mcp", headers: bad });
    expect(third.statusCode).toBe(429);
    expect(third.headers["www-authenticate"]).toBeUndefined();
  });

  it("refresh token sent as Bearer -> 401 invalid_token, and counts toward BEARER_MISS (prefix mismatch)", async () => {
    // "A mismatched prefix isn't looked up in the DB" is not asserted here (removing the isAccessTokenShape early return gives an identical response
    // and bucket count after a failed lookup); it is guarded by the prefix unit test in test/unit/api-token.test.ts.
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const refreshAsBearer = { authorization: `Bearer knbr_${"a".repeat(43)}` };
    const first = await app.inject({ method: "GET", url: "/api/mcp", headers: refreshAsBearer });
    expect(first.statusCode).toBe(401);
    expect(first.headers["www-authenticate"]).toContain(`error="invalid_token"`);
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: refreshAsBearer })).statusCode).toBe(429);
  });

  it("expired PAT -> 401; non-expiring PAT (access_expires_at IS NULL) -> passes", async () => {
    const { app, db } = await buildTestApp();
    const expired = await seedToken(db, { expiresAt: new Date(Date.now() - 1000) });
    const never = await seedToken(db, { expiresAt: null });
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${expired.token}` } }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${never.token}` } }))
        .statusCode
    ).toBe(405);
  });

  it("suspended user's token -> 401; mustChangePassword token -> 401", async () => {
    const { app, db } = await buildTestApp();
    const disabled = await seedToken(db, { disabled: true });
    const mustChange = await seedToken(db, { mustChangePassword: true });
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${disabled.token}` } }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${mustChange.token}` } }))
        .statusCode
    ).toBe(401);
  });

  it("with both Bearer and cookie only the Bearer counts (no fallback to the session)", async () => {
    const { app, db } = await buildTestApp();
    const [user] = await db
      .insert(users)
      .values({ email: `both-${randomUUID()}@example.com`, displayName: "B" })
      .returning();
    const cookie = await signTestSession({ userId: user.id, tv: 0 });

    // Precondition: the cookie alone authenticates (405), so the 401 below comes from the Bearer.
    const cookieOnly = await app.inject({ method: "GET", url: "/api/mcp", cookies: { [SESSION_COOKIE]: cookie } });
    expect(cookieOnly.statusCode).toBe(405);

    // Same request with a broken Bearer added: must be 401, must not fall back to the cookie and become 405
    const both = await app.inject({
      method: "GET",
      url: "/api/mcp",
      cookies: { [SESSION_COOKIE]: cookie },
      headers: { authorization: `Bearer ${randomToken()}` },
    });
    expect(both.statusCode).toBe(401);
    expect(both.headers["www-authenticate"]).toContain(`error="invalid_token"`);
  });

  it("last_used_at: first request writes, a second within 60 seconds doesn't write again (throttled)", async () => {
    const { app, db } = await buildTestApp();
    const { token, tokenId } = await seedToken(db);
    const read = async () => (await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)))[0];
    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    await waitFor(async () => (await read()).lastUsedAt !== null);
    const first = await read();
    expect(first.lastUsedAt).not.toBeNull();

    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    // A negative assertion (no second write) can't be rescued by polling - wait a fixed time so a write, if any, has time to land.
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await read();
    expect(second.lastUsedAt!.getTime()).toBe(first.lastUsedAt!.getTime());
  });

  it("an oauth grant's Bearer also updates oauth_clients.last_used_at (the opportunistic cleanup of #132 depends on it)", async () => {
    const { app, db } = await buildTestApp();
    // There is no product path that creates an oauth grant yet, so a row is inserted directly: this branch's logic already lives in auth/bearer.ts
    // and needs a guard now, not when #132 lands.
    const [user] = await db
      .insert(users)
      .values({ email: `oa-${randomUUID()}@example.com`, displayName: "O" })
      .returning();
    const stale = new Date(Date.now() - 10 * 86_400_000);
    await db.insert(oauthClients).values({
      clientId: "c-last-used",
      clientName: "MCP client",
      redirectUris: ["http://127.0.0.1:1/cb"],
      lastUsedAt: stale,
    });
    const token = randomToken();
    await db.insert(apiTokens).values({
      userId: user.id,
      kind: "oauth",
      name: "MCP client",
      scope: "notes:read notes:write",
      accessTokenHash: hash(token),
      refreshTokenHash: hash(`r-${token}`),
      clientId: "c-last-used",
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    const readClient = async () =>
      (await db.select().from(oauthClients).where(eq(oauthClients.clientId, "c-last-used")))[0];
    await waitFor(async () => (await readClient()).lastUsedAt.getTime() > stale.getTime());

    const client = await readClient();
    expect(client.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("after passing, request.user is the user projected by the gate, authKind depends on the path", async () => {
    // On the token path request.user is what the three notes routes use for ownership decisions - setting it to the DB api_tokens row
    // (instead of the gate's user) wouldn't turn the tests red, so it is pinned explicitly here.
    const { app, db } = await buildTestApp();
    app.get("/__test/whoami-auth", { preHandler: app.authenticateTokenOrSession("notes:read") }, async request => ({
      id: request.user?.id,
      email: request.user?.email,
      authKind: request.authKind,
      tokenScope: request.tokenScope ?? null,
      tokenId: request.tokenId ?? null,
    }));
    await app.ready();

    const { token, userId, tokenId } = await seedToken(db, { scope: "notes:read" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const viaToken = await app.inject({
      method: "GET",
      url: "/__test/whoami-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.json()).toEqual({
      id: userId,
      email: user.email,
      authKind: "token",
      tokenScope: "notes:read",
      tokenId,
    });

    const cookie = await signTestSession({ userId, tv: 0 });
    const viaSession = await app.inject({ method: "GET", url: "/__test/whoami-auth", cookies: { [SESSION_COOKIE]: cookie } });
    expect(viaSession.statusCode).toBe(200);
    expect(viaSession.json()).toEqual({ id: userId, email: user.email, authKind: "session", tokenScope: null, tokenId: null });
  });

  it("cookie-only route sends no challenge (Bearer to /api/auth/me -> 401 without the header)", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("neither token plaintext nor the Authorization header reaches the log", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const { app, db } = await buildTestApp({}, { logger: { level: "info", stream: sink } });
    const { token } = await seedToken(db);
    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });

    const output = chunks.join("");
    // First confirm the log really has output, otherwise the two assertions below are vacuous (false green)
    expect(output).toContain("/api/mcp");
    expect(output).not.toContain(token);
    expect(output.toLowerCase()).not.toContain("authorization");
  });

  it("5xx error log records authKind (otherwise request.authKind is a write-only dead field)", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const { app, db } = await buildTestApp({}, { logger: { level: "info", stream: sink } });
    // `withTestRoutes`'s /__test/throw is the existing "throw an exception" route; authKind only exists once authenticateTokenOrSession is attached,
    // so a same-shaped route is mounted separately here.
    app.get("/__test/throw-auth", { preHandler: app.authenticateTokenOrSession("notes:read") }, async () => {
      throw new Error("boom");
    });
    await app.ready();

    const { token } = await seedToken(db);
    const res = await app.inject({
      method: "GET",
      url: "/__test/throw-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(500);

    const output = chunks.join("");
    // Pins that the token path really writes authKind into the request - asserting only toContain("token") is a tautological false guard
    // (the field name tokenId itself contains token).
    expect(output).toContain('"authKind":"token"');
    expect(output).not.toContain(token);
  });
});

describe("notes routes accepting Bearer (allow list)", () => {
  it("write token can call the three routes", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "T" } });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/notes/${noteId}`, headers: auth })).statusCode).toBe(200);
  });

  it("read token can call the two GETs but not POST (the required value of each route pinned one by one)", async () => {
    // Without this, changing the required value of GET /api/notes/:ref to the full notes:write still passes - a read-only token would be locked out
    // of MCP's main read route. The core semantics of the allow list is the required value of each row.
    const { app, db } = await buildTestApp();
    const writer = await seedToken(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { title: "shared" },
    });
    expect(created.statusCode).toBe(201);
    const reader = await seedToken(db, { scope: "notes:read" });
    await db.insert(noteShares).values({ noteId: created.json().id, userId: reader.userId, role: "viewer" });
    const auth = { authorization: `Bearer ${reader.token}` };

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/notes/${created.json().id}`, headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "x" } })).statusCode).toBe(403);
  });

  it("a note created by a token is owned by the token's user (request.user comes from the gate projection)", async () => {
    const { app, db } = await buildTestApp();
    const { token, userId } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "Mine" } });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/notes", headers: auth });
    expect(listed.json().map((n: { id: string }) => n.id)).toContain(created.json().id);
    const [note] = await db.select().from(notes).where(eq(notes.id, created.json().id));
    expect(note.ownerId).toBe(userId);
  });

  it("read token on POST /api/notes -> 403 insufficient_scope, challenge carries that error", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db, { scope: "notes:read" });
    const res = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
    expect(res.headers["www-authenticate"]).toContain('error="insufficient_scope"');
  });

  // #181: notes:delete adds just one member; REST's notes:write decision and /api/mcp authentication are unchanged.
  it("read/write/delete token on POST /api/notes -> 201, on POST /api/mcp initialize -> 200", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db, { scope: "notes:read notes:write notes:delete" });
    const created = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "x" },
    });
    expect(created.statusCode).toBe(201);
    expect((await mcpPost(app, INITIALIZE, { token })).statusCode).toBe(200);
  });

  it("no credentials on GET /api/notes -> 401 with challenge, scope only notes:read (discrimination is carried by the scope value)", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/notes" });
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toContain('scope="notes:read"');
    expect(challenge).toContain("/.well-known/oauth-protected-resource/api/mcp");
  });

  it("routes not opened to Bearer don't accept it: PATCH/DELETE /api/notes/:id and collab-token all 401 without challenge", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    const noteId = "00000000-0000-0000-0000-000000000000";
    const cases = [
      { method: "PATCH" as const, url: `/api/notes/${noteId}`, payload: { title: "x" } },
      { method: "DELETE" as const, url: `/api/notes/${noteId}` },
      // collab-token doesn't accept Bearer at all
      { method: "POST" as const, url: `/api/notes/${noteId}/collab-token`, payload: {} },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: auth,
        ...(c.payload ? { payload: c.payload } : {}),
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
      expect(res.headers["www-authenticate"], `${c.method} ${c.url}`).toBeUndefined();
    }
  });

  it("403 doesn't consume the write bucket nor BEARER_MISS (the charge comes after the scope check, a legitimate token doesn't implicate the same IP)", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({
        tokenWrite: new FixedWindowLimiter({ limit: 3, windowMs: 600_000 }),
        // The default quota of 30 can't be exhausted in four requests - bearerMiss is tightened too, otherwise "403 counts toward the miss bucket" flipping wouldn't turn red.
        bearerMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }),
      }),
    });
    const { token } = await seedToken(db, { scope: "notes:read" });
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/notes",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      // If the charge were before the scope check the 4th would become 429; if 403 counted toward the miss bucket the 3rd would be 429.
      expect(res.statusCode, `attempt ${i + 1}`).toBe(403);
    }
    // The "charged but return value ignored" shape isn't caught above: then the same IP sends a bad token - if the miss bucket was charged by 403 it would 429 early,
    // the correct result is 401.
    const bad = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${randomToken()}` } });
    expect(bad.statusCode).toBe(401);
  });

  it("/api/mcp and GET /api/notes share the same read bucket", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: "/api/mcp", headers: auth })).statusCode).toBe(405);
    }
    const limited = await app.inject({ method: "GET", url: "/api/notes", headers: auth });
    expect(limited.statusCode).toBe(429);
    // 429 never carries a challenge (the read bucket follows the same rule as BEARER_MISS)
    expect(limited.headers["www-authenticate"]).toBeUndefined();
  });

  it("write routes use the write bucket, not the read bucket", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({
        tokenRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }),
        tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }),
      }),
    });
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    // If the write route wrongly used the read bucket, this would be 429
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "a" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "b" } })).statusCode).toBe(201);
    const third = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "c" } });
    expect(third.statusCode).toBe(429);
    expect(third.headers["www-authenticate"]).toBeUndefined();
  });

  it("429 from the token bucket doesn't write last_used_at (last_used only records successfully authenticated requests)", async () => {
    // The opportunistic cleanup of #132 uses last_used_at to decide whether a client is "unused for 30 days"; if rate-limited requests also stamped it,
    // a token that only ever gets 429 would keep its client looking alive forever.
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }) }),
    });
    const { token, tokenId } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(429);
    // Negative assertion: wait a fixed time so a write, if any, has time to land
    await new Promise(resolve => setTimeout(resolve, 100));
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(row.lastUsedAt).toBeNull();
  });

  it("exhausting the token bucket doesn't affect the same user's session (rate limit applies only to the token path)", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const { token, userId } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(429);
    // The same user's cookie session is unaffected (repo convention: each test file signs its own via signTestSession)
    const cookie = await signTestSession({ userId, tv: 0 });
    const viaSession = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie } });
    expect(viaSession.statusCode).toBe(200);
  });
});
