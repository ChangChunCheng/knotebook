/**
 * This family uses `buildTestApp` (**no collab**): it tests the transport layer, which is unrelated to collab.
 *
 * This app does have tools (`list_notes`/`search_notes` only query the DB and register even without collab), so `tools/list`/`tools/call` return real lists/results; this file deliberately
 * does **not** assert those bodies: tool-level acceptance is in the per-tool files such as `mcp-notes.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { users } from "../src/db/schema.js";
import { buildTestApp, type TestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { INITIALIZE, PUBLIC_HOST, mcpPost, mcpRequest, rpc } from "./mcp-helpers.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";

const ISSUER = "http://localhost:3000";

// Deliberately not `helpers.ts`'s `insertPasswordUser`: no test here needs password login, and borrowing it would cost one real argon2 hash per test.
async function seedUser(db: Db): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mcp-${randomUUID()}@example.com`, displayName: "M" })
    .returning();
  return user!.id;
}

async function appWithToken(
  overrides: Partial<AppDeps> = {}
): Promise<{ app: TestApp["app"]; db: Db; token: string; userId: string }> {
  const { app, db } = await buildTestApp(overrides);
  const userId = await seedUser(db);
  const { token } = await seedTokenForUser(db, userId);
  return { app, db, token, userId };
}

describe("#108 /api/mcp transport-layer shape", () => {
  it("valid token POST initialize -> 200, a single JSON-RPC response (not 501)", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result.serverInfo.name).toBe("knotebook");
    expect(body.result.serverInfo.version).toBeTruthy();
    expect(body.result.instructions).toBeTruthy();
    // The ordering assertion for `capabilities.tools.listChanged` is in `mcp-tools-list.test.ts` and deliberately not asserted here: this file tests the transport layer, and that contract is only discriminating when `registerTool` exists.
  });

  it("two tools/list calls in a row on the same app both return 200 (the stateless transport isn't reused across requests)", async () => {
    const { app, token } = await appWithToken();
    // The claim is "both 200", not "both succeed": discrimination is deliberately at the status-code level and the body isn't looked at (with different tool sets both bodies are valid).
    // If the transport/server were reused across requests the SDK would throw `Stateless transport cannot be reused across requests.` and the second call would be 500.
    const first = await mcpPost(app, rpc("tools/list", undefined, 1), { token });
    const second = await mcpPost(app, rpc("tools/list", undefined, 2), { token });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("after three requests close() is called exactly three times (including the one where the transfer stage throws)", async () => {
    let closes = 0;
    let n = 0;
    // `beforeReply` is one app-level function called on every request, so "throw only on the third" is counted by the test.
    const { app, token } = await appWithToken({
      mcpTestHooks: {
        afterClose: () => {
          closes += 1;
        },
        beforeReply: () => {
          n += 1;
          if (n === 3) throw new Error("boom");
        },
      },
    });
    await mcpPost(app, INITIALIZE, { token });
    await mcpPost(app, rpc("tools/list", undefined, 2), { token });
    const third = await mcpPost(app, INITIALIZE, { token });
    // Deliberately not asserting the first two bodies: the semantics of the second changed from `-32601` to a real tool list once tools were registered; this test guards `close()` counting, independent of the body.
    // If it ever goes red while the assertions grew, someone added a body assertion: delete the assertion, don't change the implementation.
    expect(closes).toBe(3);
    expect(third.statusCode).toBe(500);
    expect(third.json()).toEqual({ error: { code: "internal", message: expect.any(String) } });
  });

  it("valid token GET -> 405 + Allow: POST + JSON-RPC error body", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpRequest(app, "GET", { token });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: expect.any(String) } });
  });

  it("valid token DELETE -> 405 + Allow: POST + JSON-RPC error body", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpRequest(app, "DELETE", { token });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: expect.any(String) } });
  });

  it("GET without credentials -> 401 + challenge (not 405: 405 must not be ordered before authentication)", async () => {
    const { app } = await buildTestApp();
    const res = await mcpRequest(app, "GET");
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toContain(`scope="notes:read notes:write notes:move notes:delete"`);
    expect(challenge).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
  });

  // #181: the challenge lists all four scopes at once (without notes:delete, a compliant client would never ask for delete permission).
  it("POST initialize without credentials -> 401, the challenge scopes are the four: read write move delete", async () => {
    const { app } = await buildTestApp();
    const res = await mcpPost(app, INITIALIZE);
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toContain(`scope="notes:read notes:write notes:move notes:delete"`);
  });

  it("401 / 405 / 200 / 403 responses all carry nosniff", async () => {
    const { app, token } = await appWithToken();
    const unauthorized = await mcpRequest(app, "GET");
    const methodNotAllowed = await mcpRequest(app, "GET", { token });
    const ok = await mcpPost(app, INITIALIZE, { token });
    const forbidden = await mcpPost(app, INITIALIZE, {
      token,
      origin: "http://evil.example",
      host: "evil.example",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(methodNotAllowed.statusCode).toBe(405);
    expect(ok.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    for (const [label, res] of [
      ["401", unauthorized],
      ["405", methodNotAllowed],
      ["200", ok],
      ["403", forbidden],
    ] as const) {
      expect(res.headers["x-content-type-options"], label).toBe("nosniff");
    }
  });

  it("Content-Type: text/plain -> the site's standard 415 (the global guard is ordered before the SDK)", async () => {
    const { app, token } = await appWithToken();
    // No discrimination against the handler implementation: what blocks it is the global `onRequest` guard's 415, ordered before our handler and before the SDK; even if the implementation were still the old 501 stub this test would stay green.
    const res = await mcpPost(app, INITIALIZE, { token, contentType: "text/plain" });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
  });

  it("Accept missing a media type -> 406 (SDK characterization test, no discrimination against our implementation)", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token, accept: "application/json" });
    expect(res.statusCode).toBe(406);
    const body = res.json();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("Not Acceptable");
  });

  // Origin guard: all four calls carry a valid token, because the guard runs after `authenticateTokenOrSession`; without a token you would always get 401 first and wrongly conclude the guard isn't wired.
  it("Origin = Host = evil.example (neither is the PUBLIC_URL host) -> 403", async () => {
    const { app, token } = await appWithToken();
    // Kills implementations that only compare Origin against request.host: they would let this call through (the two are equal).
    const res = await mcpPost(app, INITIALIZE, { token, origin: "http://evil.example", host: "evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: "Origin check failed: the request's Origin and Host must both match this site's address (PUBLIC_URL)." } });
  });

  it("Origin = PUBLIC_URL host, Host = evil.example -> 403", async () => {
    const { app, token } = await appWithToken();
    // Kills implementations that only compare Origin against PUBLIC_URL.
    const res = await mcpPost(app, INITIALIZE, { token, origin: `http://${PUBLIC_HOST}`, host: "evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it("Origin: null and an unparseable Origin -> 403 (not 500)", async () => {
    const { app, token } = await appWithToken();
    // Kills implementations where `new URL(origin)` isn't wrapped in try/catch: both calls would be 500.
    for (const origin of ["null", "%%%"]) {
      const res = await mcpPost(app, INITIALIZE, { token, origin, host: PUBLIC_HOST });
      expect(res.statusCode, origin).toBe(403);
    }
  });

  it("no Origin, any Host -> handled normally (a deliberate allowance)", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token, host: "whatever.example" });
    expect(res.statusCode).toBe(200);
  });

  it("GET + bad Origin + bad Host -> 403 (not 405: the guard is attached to all three routes and runs before the handler)", async () => {
    const { app, token } = await appWithToken();
    // An implementation that only guards POST would make this 405 instead of 403.
    const res = await mcpRequest(app, "GET", { token, origin: "http://evil.example", host: "evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it("body over 262144 bytes -> 413 content_too_large and no server instance was created", async () => {
    let closes = 0;
    const { app, token } = await appWithToken({ mcpTestHooks: { afterClose: () => { closes += 1; } } });
    const huge = rpc("tools/list", { pad: "x".repeat(300_000) });
    const res = await mcpPost(app, huge, { token });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: "content_too_large", message: expect.any(String) } });
    // Boundary shape of a rejection with zero side effects: it is blocked before the handler, so `afterClose` is never called.
    expect(closes).toBe(0);
  });

  it("malformed JSON body -> the site's standard 400 bad_request (not JSON-RPC -32700)", async () => {
    const { app, token } = await appWithToken();
    // What blocks it is Fastify's content-type parser, before our handler and before the SDK; the JSON-RPC parse-error code (-32700) is unreachable here (see the header of `src/routes/mcp.ts`).
    // No discrimination against the handler: even if the implementation were still the old 501 stub this test would stay green; it pins the observed behaviour (the site's 400 rather than -32700), not our implementation.
    const res = await mcpPost(app, undefined, { token, raw: "{not json" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
  });

  it("POST with no Content-Type and no body -> the SDK's 415 -32000 (Fastify goes straight into the handler)", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, undefined, { token, contentType: null });
    expect(res.statusCode).toBe(415);
    const body = res.json();
    expect(body.error.code).toBe(-32000);
    // This string comes from the SDK; if an SDK upgrade rewords it this may need to follow. Unlike the other transport-parser tests in this file, this one does discriminate:
    // it proves the SDK is really wired and `parsedBody` is passed in.
    expect(body.error.message).toContain("Unsupported Media Type");
  });

  it("POST with Content-Type: application/json but an empty body -> the site's standard 400 bad_request", async () => {
    const { app, token } = await appWithToken();
    // No discrimination against the handler: what blocks it is the content-type parser's 400, before our handler; even if the implementation were still the old 501 stub this test would stay green.
    // It pins the observed behaviour (the site's 400), not our implementation.
    const res = await mcpPost(app, undefined, { token, raw: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
  });
});
