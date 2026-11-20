/**
 * GET /api/oauth/request doesn't consume (the page can be refreshed) and isn't charged to the limiter; allow and deny both consume
 * (a double click makes one code); the quota subtracts the row this authorization will replace (otherwise re-authorizing with 20 where
 * one is this client's would 409); `req` goes through a regex before entering a SQL predicate, so strings Postgres can't store are rejected first.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../src/db/schema.js";
import { buildTestApp, createUserAndLogin, testConfig, type TestApp } from "./helpers.js";

const CHALLENGE = "a".repeat(43);
const ISSUER = testConfig.publicUrl.origin;
const RESOURCE = `${ISSUER}/api/mcp`;

async function startFlow(
  app: TestApp["app"],
  options: { redirectUri?: string; scope?: string; clientId?: string } = {}
): Promise<{ clientId: string; req: string }> {
  let clientId = options.clientId;
  if (clientId === undefined) {
    const registered = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "Test client", redirect_uris: ["http://127.0.0.1:1234/cb"] },
    });
    clientId = registered.json().client_id as string;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? "http://127.0.0.1:5678/cb",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st",
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  const res = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
  expect(res.statusCode, "authorize 應 302").toBe(302);
  const req = new URL(res.headers.location as string, "http://x").searchParams.get("req")!;
  return { clientId, req };
}

function decide(app: TestApp["app"], cookie: string, body: object) {
  return app.inject({ method: "POST", url: "/api/oauth/decision", headers: { cookie }, payload: body });
}

/** allow always carries `scope` (#239). Existing cases send read/write/move, which the server's narrowerScope clamps back to pending (same as before #239). */
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

const getRequest = (app: TestApp["app"], cookie: string, req: string) =>
  app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });

async function seedGrant(db: TestApp["db"], userId: string, clientId: string, scope: string, tag: string) {
  await db.insert(apiTokens).values({
    userId,
    kind: "oauth",
    name: "Test client",
    scope,
    accessTokenHash: tag.padEnd(64, "a"),
    refreshTokenHash: tag.padEnd(64, "b"),
    clientId,
    accessExpiresAt: new Date(Date.now() + 86_400_000),
  });
}

describe("GET /api/oauth/request", () => {
  it("200 returns the four fields; doesn't consume (refreshable)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: "notes:write" });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          clientName: "Test client",
          redirectHost: "127.0.0.1:5678", // deliberately includes a port
          scope: "notes:read notes:write",
          scopes: ["notes:read", "notes:write"],
          replacesExisting: false,
          existingScope: null,
        });
      }
      expect(await db.select().from(oauthRequests)).toHaveLength(1); // not consumed
    } finally {
      await close();
    }
  });

  it("not logged in -> 401 (cookie only)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const { req } = await startFlow(app);
      const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}` });
      expect(res.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("not found, expired, missing req, malformed req -> 410 oauth_request_invalid (same shape, not an oracle)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      // Strings that Postgres can't store (NUL, lone surrogates) must be rejected before any SQL predicate: `req` goes through a regex first. **The two NUL requests are load-bearing**: without
      // `REQUEST_ID_RE` other values merely find no row, only NUL makes PG raise 22021 and surface as a 500.
      for (const bad of ["nope", "", "\u0000", `a\u0000${"b".repeat(20)}`, "x".repeat(65), "A".repeat(22).replace("A", "!")]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/oauth/request?req=${encodeURIComponent(bad)}`,
          headers: { cookie },
        });
        expect(res.statusCode, JSON.stringify(bad)).toBe(410);
        expect(res.headers["content-type"], JSON.stringify(bad)).toContain("application/json");
        expect(res.json().error.code, JSON.stringify(bad)).toBe("oauth_request_invalid");
      }
      const missing = await app.inject({ method: "GET", url: "/api/oauth/request", headers: { cookie } });
      expect(missing.statusCode).toBe(410);

      const { req } = await startFlow(app);
      await db.update(oauthRequests).set({ expiresAt: sql`now() - interval '1 minute'` });
      const expired = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(expired.statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  it("stored redirect_uri no longer matches the registration (client re-registered) -> 404", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db
        .update(oauthClients)
        .set({ redirectUris: ["http://127.0.0.1:1234/elsewhere"] })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await close();
    }
  });

  it("replacesExisting: true when the caller already has a grant for the same client; someone else's doesn't count", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const other = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      // Someone else's grant: the request row has no user_id, so this cell can't leak other users' state
      await db.insert(apiTokens).values({
        userId: other.userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "other-h",
        refreshTokenHash: "other-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });
      const before = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(before.json().replacesExisting).toBe(false);

      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "mine-h",
        refreshTokenHash: "mine-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });
      const after = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(after.json().replacesExisting).toBe(true);
    } finally {
      await close();
    }
  });

  it("40 requests in a row never 429 (GET isn't charged)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      for (let i = 0; i < 40; i += 1) {
        const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await close();
    }
  });
});

describe("POST /api/oauth/decision", () => {
  it("allow -> 200 with redirectTo carrying code/state/iss, and creates one oauth_codes row", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app, { scope: "notes:write" });
      // register set last_used_at to now() a few seconds ago: push it back 10 days first, otherwise removing the "update
      // last_used_at after creating the code" UPDATE below couldn't be detected.
      const staleStamp = new Date(Date.now() - 10 * 86_400_000); // must be < the idle-client delete's 30 days, else the client would be purged
      await db.update(oauthClients).set({ lastUsedAt: staleStamp }).where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().redirectTo as string);
      expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:5678/cb");
      const code = url.searchParams.get("code")!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("state")).toBe("st");
      expect(url.searchParams.get("iss")).toBe(ISSUER);

      const rows = await db.select().from(oauthCodes);
      expect(rows).toHaveLength(1);
      // plaintext isn't stored (the DB has only the sha256); other fields are copied from the pending request
      expect(rows[0]!.codeHash).not.toBe(code);
      expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.userId).toBe(userId);
      expect(rows[0]!.clientId).toBe(clientId);
      expect(rows[0]!.scope).toBe("notes:read notes:write");
      expect(rows[0]!.redirectUri).toBe("http://127.0.0.1:5678/cb");
      expect(rows[0]!.codeChallenge).toBe(CHALLENGE);
      const ttl = rows[0]!.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000);

      // creating the code also updates the client's last_used_at (the idle-client delete's criterion)
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(staleStamp.getTime());
      expect(Date.now() - client!.lastUsedAt.getTime()).toBeLessThan(5_000);
    } finally {
      await close();
    }
  });

  it("no state -> redirectTo carries no state; DTO shape for a single-value scope", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const registered = await app.inject({
        method: "POST",
        url: "/oauth/register",
        payload: { redirect_uris: ["http://127.0.0.1:1234/cb"] },
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: registered.json().client_id as string,
        redirect_uri: "http://127.0.0.1:1234/cb",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        resource: RESOURCE,
      });
      const auth = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
      const req = new URL(auth.headers.location as string, "http://x").searchParams.get("req")!;

      const dto = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(dto.json()).toMatchObject({ clientName: "MCP client", scope: "notes:read", scopes: ["notes:read"] });

      const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      const url = new URL(res.json().redirectTo as string);
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.has("code")).toBe(true);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
    } finally {
      await close();
    }
  });

  it("deny -> 200 redirectTo carries access_denied, and also consumes the pending request", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      const denied = await decide(app, cookie, { req, decision: "deny" });
      expect(denied.statusCode).toBe(200);
      const url = new URL(denied.json().redirectTo as string);
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("state")).toBe("st");
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);

      const again = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(again.statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  it("same req allowed twice -> second 410, and only one code created", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      expect((await decide(app, cookie, { req, decision: "allow", scope: RWM })).statusCode).toBe(200);
      const second = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(second.statusCode).toBe(410);
      expect(second.json().error.code).toBe("oauth_request_invalid");
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("wrong body shape -> 400 invalid_body; wrong req shape -> 410 (unstorable strings rejected before SQL)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      for (const body of [{ req: "x", decision: "maybe" }, { decision: "allow" }, {}]) {
        const res = await decide(app, cookie, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error.code).toBe("invalid_body");
      }
      // Same as above: the NUL requests are what tell "guarded" from "unguarded but nothing found"
      for (const req of ["\u0000", `a\u0000${"b".repeat(20)}`, "nope", "x".repeat(65)]) {
        // Add a valid scope: without it body validation rejects with 400 first and the guard against unstorable strings wouldn't be reached
        const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
        expect(res.statusCode, JSON.stringify(req)).toBe(410);
        expect(res.headers["content-type"], JSON.stringify(req)).toContain("application/json");
        expect(res.json().error.code).toBe("oauth_request_invalid");
      }
    } finally {
      await close();
    }
  });

  it("not logged in -> 401; mustChangePassword -> 403 and doesn't consume", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { req } = await startFlow(app);
      const anon = await app.inject({ method: "POST", url: "/api/oauth/decision", payload: { req, decision: "allow" } });
      expect(anon.statusCode).toBe(401);

      const locked = await createUserAndLogin(db, { mustChangePassword: true });
      const res = await decide(app, locked.cookie, { req, decision: "allow", scope: RWM });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
      expect(await db.select().from(oauthRequests)).toHaveLength(1); // not wasted
    } finally {
      await close();
    }
  });

  it("quota: 20 counted grants -> 409; when one belongs to this client it passes", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db.insert(apiTokens).values(
        Array.from({ length: 19 }, (_, i) => ({
          userId,
          kind: "pat" as const,
          name: `pat${i}`,
          scope: "notes:read" as const,
          accessTokenHash: `pat-${i}`,
          accessExpiresAt: null,
        }))
      );
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "same-client",
        refreshTokenHash: "same-client-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      const ok = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(ok.statusCode).toBe(200); // the row this authorization replaces is subtracted

      // A new client: also 20, nothing to subtract this time -> 409
      const other = await startFlow(app);
      const limited = await decide(app, cookie, { req: other.req, decision: "allow", scope: RWM });
      expect(limited.statusCode).toBe(409);
      expect(limited.json().error.code).toBe("token_limit");
      // The 409 request still consumed the pending request (the single-use check runs before the quota check)
      expect((await decide(app, cookie, { req: other.req, decision: "allow", scope: RWM })).statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  // Guards the definition of "counted" for the quota: oauth grants always count, **even when access has expired** (refresh never
  // expires). If the predicate counted only unexpired ones this case would be 200.
  it("20 oauth grants all with expired access: authorizing a new client still gets 409", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      for (let i = 0; i < 20; i += 1) {
        await db.insert(oauthClients).values({
          clientId: `c${i}`,
          clientName: `c${i}`,
          redirectUris: ["http://127.0.0.1/cb"],
        });
        await db.insert(apiTokens).values({
          userId,
          kind: "oauth",
          name: `c${i}`,
          scope: "notes:read",
          accessTokenHash: `h${i}`,
          refreshTokenHash: `r${i}`,
          clientId: `c${i}`,
          accessExpiresAt: sql`now() - interval '1 hour'`,
        });
      }
      const { req } = await startFlow(app); // a brand new 21st client
      const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("token_limit");
    } finally {
      await close();
    }
  });

  it("client re-registered after consumption (stored redirect_uri mismatch) -> 404", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db
        .update(oauthClients)
        .set({ redirectUris: ["http://127.0.0.1:1234/elsewhere"] })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(res.statusCode).toBe(404);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("decision's opportunistic cleanup runs before consumption: a pending request whose zombie client crossed the 24 h boundary -> 410, not 500", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      // Push the client back 25 hours: it has no grant/code, so the zombie delete removes it (CASCADE takes the request)
      await db
        .update(oauthClients)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow", scope: RWM });
      expect(res.statusCode).toBe(410);
    } finally {
      await close();
    }
  });
});

describe("decision scope (#239)", () => {
  it("allow without scope -> 400, pending still there (GET request still 200)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: "notes:write" });
      const res = await decide(app, cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
      expect((await getRequest(app, cookie, req)).statusCode).toBe(200);
      expect(await db.select().from(oauthRequests)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // The "not a stored shape" half: aliases and combinations missing write are always 400, neither normalized nor consumed (five shapes since #181).
  it.each(["notes:write", "notes:read notes:move", "notes:move", "notes:read notes:delete"])(
    "allow with a non-stored scope=%s -> 400, pending still there; the same req with a valid scope can still be allowed",
    async scope => {
      const { app, db, close } = await buildTestApp();
      try {
        const { cookie } = await createUserAndLogin(db);
        const { req } = await startFlow(app, { scope: RWM });
        const res = await decide(app, cookie, { req, decision: "allow", scope });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("invalid_body");
        expect(await db.select().from(oauthRequests)).toHaveLength(1);
        expect((await decide(app, cookie, { req, decision: "allow", scope: RWM })).statusCode).toBe(200);
      } finally {
        await close();
      }
    }
  );

  it.each([
    [RWM, "notes:read notes:write", "notes:read notes:write"],
    ["notes:write", RWM, "notes:read notes:write"], // clamped back to pending
    [RWM, "notes:read", "notes:read"],
    // Grant = requested intersected with ticked (an intersection on the lattice, not the smaller on a chain) (#181).
    [RWM, RWD, "notes:read notes:write"], // move and delete don't include each other -> only read/write remains
    [RWMD, RWMD, RWMD],
    [RWD, RWMD, RWD], // not more than requested
    [RWMD, "notes:read", "notes:read"],
    [RWD, "notes:read notes:write", "notes:read notes:write"], // the consent page un-ticks delete and keeps edit
    [RWMD, RWM, RWM], // un-ticks delete, keeps move
  ])("pending=%s, body=%s -> code.scope=%s", async (requested, body, granted) => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: requested });
      const res = await decide(app, cookie, { req, decision: "allow", scope: body });
      expect(res.statusCode).toBe(200);
      const codes = await db.select().from(oauthCodes);
      expect(codes.map(c => c.scope)).toEqual([granted]);
    } finally {
      await close();
    }
  });

  it("deny without scope -> 200, redirectTo contains error=access_denied", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: RWM });
      const res = await decide(app, cookie, { req, decision: "deny" });
      expect(res.statusCode).toBe(200);
      expect(new URL(res.json().redirectTo as string).searchParams.get("error")).toBe("access_denied");
    } finally {
      await close();
    }
  });

  it("deny with a garbage scope -> still 200 access_denied (deny ignores scope)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: RWM });
      const res = await decide(app, cookie, { req, decision: "deny", scope: "garbage" });
      expect(res.statusCode).toBe(200);
      expect(new URL(res.json().redirectTo as string).searchParams.get("error")).toBe("access_denied");
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe("existingScope (#239)", () => {
  it("no existing row -> null/false; this user's read/write row for the same client -> read/write/true; another user's row for the same client and this user's row for another client don't count", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const me = await createUserAndLogin(db);
      const other = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app, { scope: RWM });
      const { clientId: otherClient } = await startFlow(app, { scope: RWM });
      await seedGrant(db, other.userId, clientId, RWM, "o1"); // someone else's, same client
      await seedGrant(db, me.userId, otherClient, RWM, "m1"); // this user's, another client
      expect((await getRequest(app, me.cookie, req)).json()).toMatchObject({ existingScope: null, replacesExisting: false });
      await seedGrant(db, me.userId, clientId, "notes:read notes:write", "m2");
      expect((await getRequest(app, me.cookie, req)).json()).toMatchObject({
        existingScope: "notes:read notes:write",
        replacesExisting: true,
      });
    } finally {
      await close();
    }
  });

  // existingScope returns one of the five shapes unchanged; it is only the consent page's default ticks, and decision grants "requested intersected with ticked" without looking at it (#181).
  it("existing read/write/delete row, now requesting read/write/move -> existingScope is read/write/delete; allow with read/write/move -> code is read/write/move", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const me = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app, { scope: RWM });
      await seedGrant(db, me.userId, clientId, RWD, "d1");
      expect((await getRequest(app, me.cookie, req)).json()).toMatchObject({ existingScope: RWD, replacesExisting: true });
      expect((await decide(app, me.cookie, { req, decision: "allow", scope: RWM })).statusCode).toBe(200);
      expect((await db.select().from(oauthCodes)).map(c => c.scope)).toEqual([RWM]);
    } finally {
      await close();
    }
  });
});
