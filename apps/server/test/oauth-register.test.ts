/**
 * Loopback-only: an unauthenticated DCR accepting remote redirects would let anyone register a nice-sounding name for one-click
 * phishing. Unsupported metadata is rejected rather than silently accepted.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { oauthClients } from "../src/db/schema.js";
import { buildTestApp, freshLimiters, type TestApp } from "./helpers.js";

const OK_BODY = { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:1234/cb"] };

async function register(app: TestApp["app"], body: object) {
  return app.inject({ method: "POST", url: "/oauth/register", payload: body });
}

describe("POST /oauth/register", () => {
  it("201 returns the registration result, issues no secret, fixed fields", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, OK_BODY);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(body.client_name).toBe("Claude Code");
      expect(body.redirect_uris).toEqual(OK_BODY.redirect_uris);
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      expect(body.response_types).toEqual(["code"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      // epoch **seconds** (RFC 7591): milliseconds would fail these two
      expect(body.client_id_issued_at).toBeGreaterThan(1_700_000_000);
      expect(body.client_id_issued_at).toBeLessThan(Date.now() / 1000 + 60);
      // the two headers on the 201 (the RFC 7591 §3.2.1 example has both)
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
      expect(body).not.toHaveProperty("client_secret");
    } finally {
      await close();
    }
  });

  it("client_name omitted -> stored as the fixed string MCP client", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const res = await register(app, { redirect_uris: ["http://localhost/cb"] });
      expect(res.statusCode).toBe(201);
      expect(res.json().client_name).toBe("MCP client");
      const [row] = await db.select({ name: oauthClients.clientName }).from(oauthClients);
      expect(row!.name).toBe("MCP client");
    } finally {
      await close();
    }
  });

  it("redirect_uri that is non-loopback / has a query / has a fragment / has userinfo -> 400 invalid_redirect_uri", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      for (const uri of [
        "https://example.com/cb",
        "http://localhost.evil.com/cb",
        "http://mylocalhost/cb",
        "http://127.0.0.1/cb?x=1",
        "http://127.0.0.1/cb#f",
        "http://user:pw@127.0.0.1/cb",
        "not a url",
      ]) {
        const res = await register(app, { redirect_uris: [uri] });
        expect(res.statusCode, uri).toBe(400);
        expect(res.json().error, uri).toBe("invalid_redirect_uri");
      }
      // nothing was stored (rejection happens before the insert)
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("with multiple redirect_uris one bad one rejects the whole batch", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, {
        redirect_uris: ["http://127.0.0.1:1234/cb", "https://example.com/cb"],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    } finally {
      await close();
    }
  });

  it("redirect_uris empty, more than 8, or one too long -> 400 invalid_redirect_uri", async () => {
    const { app, close } = await buildTestApp();
    try {
      const long = `http://127.0.0.1/${"a".repeat(520)}`;
      for (const uris of [[], Array.from({ length: 9 }, (_, i) => `http://127.0.0.1/cb${i}`), [long]]) {
        const res = await register(app, { redirect_uris: uris });
        expect(res.statusCode, JSON.stringify(uris).slice(0, 40)).toBe(400);
        expect(res.json().error).toBe("invalid_redirect_uri");
      }
      // Positive control: exactly 8 valid -> 201 (the limit is 8, not 7)
      const ok = await register(app, {
        redirect_uris: Array.from({ length: 8 }, (_, i) => `http://127.0.0.1/cb${i}`),
      });
      expect(ok.statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("missing redirect_uris -> 400 invalid_redirect_uri (not invalid_client_metadata)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { client_name: "X" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    } finally {
      await close();
    }
  });

  it("unsupported metadata -> 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const extra of [
        { token_endpoint_auth_method: "client_secret_basic" },
        { grant_types: ["client_credentials"] },
        { grant_types: ["authorization_code", "implicit"] },
        { response_types: ["token"] },
        { response_types: ["code", "token"] },
        { client_name: "" },
        { client_name: "x".repeat(65) },
      ]) {
        const res = await register(app, { ...OK_BODY, ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json().error, JSON.stringify(extra)).toBe("invalid_client_metadata");
      }
    } finally {
      await close();
    }
  });

  it("supported metadata with explicit values -> 201 (positive control)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, {
        ...OK_BODY,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  // An all-whitespace name is also a visual hole on the consent page: length 0 after trim must be 400
  it("all-whitespace client_name -> 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const name of ["   ", "\t\t"]) {
        const res = await register(app, { ...OK_BODY, client_name: name });
        expect(res.statusCode, JSON.stringify(name)).toBe(400);
        expect(res.json().error).toBe("invalid_client_metadata");
      }
    } finally {
      await close();
    }
  });

  it("client_name containing a bidi override character -> 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, client_name: `Claude${String.fromCodePoint(0x202e)}Code` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_client_metadata");
    } finally {
      await close();
    }
  });

  // trim runs before the blocklist: leading/trailing line-separator characters are stripped rather than answered with 400
  // (direction-safe: the dangerous characters vanish before display), but the stored name must not contain them.
  it("leading/trailing U+2028 is trimmed -> 201 and the stored name doesn't contain it", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, client_name: `${String.fromCodePoint(0x2028)}App` });
      expect(res.statusCode).toBe(201);
      expect(res.json().client_name).toBe("App");
      const [row] = await db.select({ name: oauthClients.clientName }).from(oauthClients);
      expect(row!.name).toBe("App");
    } finally {
      await close();
    }
  });

  it("unknown fields are ignored on receipt, the response doesn't echo them", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, application_type: "native", software_id: "x" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty("software_id");
      expect(res.json()).not.toHaveProperty("application_type");
    } finally {
      await close();
    }
  });

  it("over the DCR quota -> 429 RFC-shaped", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ dcr: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      expect((await register(app, OK_BODY)).statusCode).toBe(201);
      expect((await register(app, OK_BODY)).statusCode).toBe(201);
      const res = await register(app, OK_BODY);
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("invalid_request");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await close();
    }
  });

  it("cleanup runs before the table insert: a zombie client from 25 hours ago disappears after this request", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await register(app, OK_BODY);
      const ids = (await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id);
      expect(ids).not.toContain("zombie");
      expect(ids).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("content-type other than JSON -> 415 RFC-shaped", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauth/register",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "redirect_uris=x",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("two registrations get different client_ids", async () => {
    const { app, close } = await buildTestApp();
    try {
      const a = (await register(app, OK_BODY)).json().client_id as string;
      const b = (await register(app, OK_BODY)).json().client_id as string;
      expect(a).not.toBe(b);
    } finally {
      await close();
    }
  });

  it("#372: body over the limit -> 413 RFC-shaped, error_description is the same fixed English sentence as REST", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, pad: "x".repeat(1_100_000) });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        error: "invalid_request",
        error_description: "The request body is over this endpoint's size limit. Send a smaller request.",
      });
    } finally {
      await close();
    }
  });
});
