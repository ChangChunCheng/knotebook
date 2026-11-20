/**
 * Rate limiting sits before any DB access and is consume-always. Only an untrusted redirect_uri is not redirected to (RFC 6749 §4.1.2.1);
 * everything else is a 302 with a structured error back to the client, otherwise the client sits on a plain-text page until it times out.
 * The 400 page for the untrusted case is fully static and echoes no request parameter.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { oauthClients, oauthRequests } from "../src/db/schema.js";
import { buildTestApp, createUserAndLogin, freshLimiters, testConfig, type TestApp } from "./helpers.js";

const CHALLENGE = "a".repeat(43);
const ISSUER = testConfig.publicUrl.origin;
const RESOURCE = `${ISSUER}/api/mcp`;

async function seedClient(app: TestApp["app"], redirectUri: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { client_name: "Test client", redirect_uris: [redirectUri] },
  });
  return res.json().client_id as string;
}

function authorizeUrl(params: Record<string, string>): string {
  return `/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

function baseParams(clientId: string, redirectUri: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st",
  };
}

describe("GET /oauth/authorize", () => {
  it("all valid -> creates a pending request and 302s to the SPA consent page", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:5678/cb"), scope: "notes:write" }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=[A-Za-z0-9_-]{22}$/);
      // Caching this 302 -> /authorize?req=<id> in an intermediary must not happen
      expect(res.headers["cache-control"]).toBe("no-store");

      const [row] = await db.select().from(oauthRequests);
      expect(row!.clientId).toBe(clientId);
      // Stores the full value sent this time (including the ephemeral port), not the registered value
      expect(row!.redirectUri).toBe("http://127.0.0.1:5678/cb");
      expect(row!.scope).toBe("notes:read notes:write");
      expect(row!.state).toBe("st");
      expect(row!.codeChallenge).toBe(CHALLENGE);
    } finally {
      await close();
    }
  });

  it("scope omitted -> stored with least privilege (notes:read)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const params = baseParams(clientId, "http://127.0.0.1:1234/cb");
      const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
      expect(res.statusCode).toBe(302);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.scope).toBe("notes:read");
    } finally {
      await close();
    }
  });

  // A move only counts when edit is requested too (normalizeScope) (#239).
  it.each([
    ["notes:read notes:write notes:move", "notes:read notes:write notes:move"],
    ["notes:read notes:move", "notes:read"],
    // Delete also needs edit; order doesn't matter, storage is always read -> write -> move -> delete (#181).
    ["notes:read notes:write notes:delete", "notes:read notes:write notes:delete"],
    ["notes:delete notes:move notes:write", "notes:read notes:write notes:move notes:delete"],
    ["notes:read notes:delete", "notes:read"],
  ])("#239 scope=%s -> stored %s", async (requested, stored) => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), scope: requested }),
      });
      expect(res.statusCode).toBe(302);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.scope).toBe(stored);
    } finally {
      await close();
    }
  });

  it("#181: requesting read/write/move/delete -> the consent page's request endpoint returns scopes as a split array (including notes:delete)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), scope: "notes:delete notes:write notes:move notes:read" }),
      });
      const req = new URL(res.headers.location as string, "http://x").searchParams.get("req")!;
      const dto = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(dto.statusCode).toBe(200);
      expect(dto.json()).toMatchObject({
        scope: "notes:read notes:write notes:move notes:delete",
        scopes: ["notes:read", "notes:write", "notes:move", "notes:delete"],
      });
    } finally {
      await close();
    }
  });

  it("unregistered client_id and non-matching redirect_uri -> 400 static plain text, no redirect back, no parameter echo", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const cases = [
        baseParams("nosuchclient", "http://127.0.0.1:1234/cb"),
        baseParams(clientId, "http://127.0.0.1:1234/other"),
      ];
      for (const params of cases) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(res.body).toContain("重新加入");
        // Strings controlled by an unauthenticated party are never echoed (no HTML means no CSP issue, still not echoed)
        expect(res.body).not.toContain(params.client_id);
        expect(res.body).not.toContain(params.redirect_uri);
      }
      // An untrusted request creates no pending request
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("client_id or redirect_uri missing/too long -> 400 and the body doesn't contain the submitted strings", async () => {
    const { app, close } = await buildTestApp();
    try {
      const longId = "c".repeat(65);
      const longUri = `http://127.0.0.1/${"a".repeat(520)}`;
      const cases: Array<Record<string, string>> = [
        baseParams(longId, "http://127.0.0.1/cb"),
        baseParams("ok", longUri),
      ];
      for (const params of cases) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        // Must be the early-parameter message: without the length cap it would land on the client-lookup "registration no longer valid"
        // explainer page, which is also 400/text-plain/without the submitted string; this assertion tells them apart.
        expect(res.body).toContain("缺少必要參數");
        expect(res.body).not.toContain(longId);
        expect(res.body).not.toContain(longUri);
      }
      // No parameters at all
      for (const params of [{}, { client_id: "x" }, { redirect_uri: "http://127.0.0.1/cb" }]) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params as Record<string, string>) });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await close();
    }
  });

  // client_id goes into a SQL predicate (not an INSERT): a bind parameter containing NUL makes PG raise 22021, which reaching
  // the error handler would be a 500 on an unauthenticated endpoint.
  it("client_id containing NUL -> 400 explainer page, not 500", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("\u0000", "http://127.0.0.1:1234/cb")),
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toContain("重新加入");
    } finally {
      await close();
    }
  });

  it("port at authorization differing from registration is still allowed (RFC 8252 section 7.3)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams(clientId, "http://127.0.0.1:59999/cb")),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=/);
    } finally {
      await close();
    }
  });

  it("errors after the redirect_uri is trusted are always a 302 with a structured error back to redirect_uri, carrying iss and the original state", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const redirectUri = "http://127.0.0.1:1234/cb";
      const cases: Array<[Record<string, string>, string]> = [
        [{ response_type: "token" }, "unsupported_response_type"],
        [{ code_challenge_method: "plain" }, "invalid_request"],
        [{ code_challenge: "short" }, "invalid_request"],
        [{ code_challenge: "!".repeat(43) }, "invalid_request"],
        [{ code_challenge: "a".repeat(129) }, "invalid_request"],
        [{ resource: `${ISSUER}/API/MCP` }, "invalid_target"],
        [{ resource: `${ISSUER}/api/mcp/` }, "invalid_target"],
      ];
      for (const [override, expected] of cases) {
        const params = { ...baseParams(clientId, redirectUri), ...override };
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode, expected).toBe(302);
        const url = new URL(res.headers.location as string);
        expect(`${url.origin}${url.pathname}`, expected).toBe(redirectUri);
        expect(url.searchParams.get("error"), expected).toBe(expected);
        expect(url.searchParams.get("state"), expected).toBe("st");
        expect(url.searchParams.get("iss"), expected).toBe(ISSUER);
        expect(url.searchParams.get("error_description"), expected).toBeTruthy();
      }
      // Such failures create no pending request
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("resource missing -> invalid_target (RFC 8707 section 2.1, same code as invalid)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const params = baseParams(clientId, "http://127.0.0.1:1234/cb");
      delete params.resource;
      const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
      expect(res.statusCode).toBe(302);
      expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_target");
    } finally {
      await close();
    }
  });

  it("resource with different-case scheme/host is still accepted", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({
          ...baseParams(clientId, "http://127.0.0.1:1234/cb"),
          resource: RESOURCE.replace("http://", "HTTP://").replace("localhost", "LOCALHOST"),
        }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=/);
    } finally {
      await close();
    }
  });

  it("state of 2048 chars returned as is; 2049 chars -> invalid_request and state not echoed", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const ok = "s".repeat(2048);
      const okRes = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: ok }),
      });
      expect(okRes.statusCode).toBe(302);
      expect(okRes.headers.location).toMatch(/^\/authorize\?req=/);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.state).toBe(ok); // stored as is, no truncation

      const tooLong = "s".repeat(2049);
      const badRes = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: tooLong }),
      });
      expect(badRes.statusCode).toBe(302);
      const url = new URL(badRes.headers.location as string);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      // The failure reason is the over-long state -> not echoed
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
    } finally {
      await close();
    }
  });

  it("over-long scope/resource -> invalid_request", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const overrides: Array<Record<string, string>> = [
        { scope: "s".repeat(513) },
        { resource: `${RESOURCE}${"x".repeat(513)}` },
      ];
      for (const override of overrides) {
        const res = await app.inject({
          method: "GET",
          url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), ...override }),
        });
        expect(res.statusCode).toBe(302);
        expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // state is the only string on this path with no other character guard (a text column can't store NUL -> 22021 -> 500 on an
  // unauthenticated endpoint); rejected without echoing it. Only NUL is tested: a lone surrogate can't arrive through the query
  // string (URLSearchParams encodes it as U+FFFD); the implementation still blocks it to share one predicate with redirect_uri,
  // which can really carry it via jsonb.
  it("state containing NUL -> invalid_request, state not echoed, nothing in the DB", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: "\u0000x" }),
      });
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // Positive control: a paired surrogate is a legal astral character and must not be blocked
  it("state containing emoji (paired surrogates) is stored and returned as is", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const state = "ok-\u{1F600}";
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state }),
      });
      expect(res.statusCode).toBe(302);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.state).toBe(state);
    } finally {
      await close();
    }
  });

  it("state containing & and # is encoded correctly (always the URL API, no string concatenation)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({
          ...baseParams(clientId, "http://127.0.0.1:1234/cb"),
          state: "a&x=1#f",
          response_type: "token",
        }),
      });
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get("state")).toBe("a&x=1#f");
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(url.searchParams.get("error")).toBe("unsupported_response_type");
    } finally {
      await close();
    }
  });

  it("consume-always: a valid request is counted too; over the limit -> 429 plain text and nothing in the DB", async () => {
    const { app, db, close } = await buildTestApp({
      limiters: freshLimiters({ authorize: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const url = authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb"));
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);

      const before = await db.select({ id: oauthRequests.id }).from(oauthRequests);
      const limited = await app.inject({ method: "GET", url });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["content-type"]).toBe("text/plain; charset=utf-8");
      const after = await db.select({ id: oauthRequests.id }).from(oauthRequests);
      expect(after).toHaveLength(before.length); // an over-limit request doesn't reach the DB

      // Discriminates "limiting happens before any DB access": a nonexistent client_id over the limit must get 429, not the 400
      // explainer page found only after the client lookup. Without this request, moving consume after the opportunistic cleanup
      // (`runOauthCleanup`) and the client lookup (every over-limit request would run 5 full-table scans) would stay green.
      const unknownClient = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("nosuchclient", "http://127.0.0.1:1234/cb")),
      });
      expect(unknownClient.statusCode).toBe(429);
    } finally {
      await close();
    }
  });

  it("early-parameter failures don't spend limiter quota (rejected before consume)", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ authorize: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      // Three early-parameter failures: if they consumed quota, the two valid requests after would get 429. Both the
      // missing-parameter and over-long forms are needed: with only missing parameters, removing the length cap would stay green.
      for (let i = 0; i < 3; i += 1) {
        expect((await app.inject({ method: "GET", url: "/oauth/authorize" })).statusCode).toBe(400);
      }
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({
          method: "GET",
          url: authorizeUrl(baseParams("c".repeat(65), "http://127.0.0.1:1234/cb")),
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain("缺少必要參數");
      }
      const url = authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb"));
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
    } finally {
      await close();
    }
  });

  it("opportunistic cleanup runs before the client lookup: a zombie client from 25 hours ago lands on the explainer page, not a 500", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1:1234/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("zombie", "http://127.0.0.1:1234/cb")),
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toContain("重新加入");
    } finally {
      await close();
    }
  });

  it("a pending request expires after 10 minutes", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      await app.inject({ method: "GET", url: authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb")) });
      const [row] = await db.select().from(oauthRequests);
      const ttlMs = row!.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(9 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);
    } finally {
      await close();
    }
  });
});
