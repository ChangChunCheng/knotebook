import { describe, expect, it } from "vitest";
import { apiTokens } from "../src/db/schema.js";
import { buildTestApp, createUserAndLogin, freshLimiters } from "./helpers.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedUser } from "./group-helpers.js";
import { ISSUER, RESOURCE, codeGrant, exchange, obtainCode, pkce } from "./helpers/oauth-flow.js";

const FULL = "notes:read notes:write notes:move notes:delete";

async function fillPats(db: Parameters<typeof seedTokenForUser>[0], userId: string, n: number) {
  const tokens: string[] = [];
  for (let i = 0; i < n; i += 1) tokens.push((await seedTokenForUser(db, userId, "notes:read", `pat${i}`)).token);
  return tokens;
}

async function startFlow(app: Awaited<ReturnType<typeof buildTestApp>>["app"]) {
  const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Test client", redirect_uris: ["http://127.0.0.1:1234/cb"] } });
  const clientId = registered.json().client_id as string;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:5678/cb",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const res = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
  expect(res.statusCode, "authorize 應 302").toBe(302);
  return new URL(res.headers.location as string, ISSUER).searchParams.get("req")!;
}

describe("apiTokensPerUser takes effect immediately", () => {
  it("PAT creation: after lowering the limit to 2 the 3rd is 409 token_limit with the current value in the message; the existing 3 still work", async () => {
    const { app, db, siteLimits, close } = await buildTestApp({
      limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }),
    });
    try {
      const admin = await seedUser(db, { isAdmin: true });
      const { cookie, userId } = await createUserAndLogin(db);
      const existing = await fillPats(db, userId, 3);
      const create = (name: string) =>
        app.inject({ method: "POST", url: "/api/auth/tokens", headers: { cookie }, payload: { name, scope: "notes:read", expiresInDays: null } });

      await siteLimits.update(admin.id, { apiTokensPerUser: 2 });
      const over = await create("extra");
      expect(over.statusCode).toBe(409);
      expect(over.json().error.code).toBe("token_limit");
      expect(over.json().error.message).toBe("You already have the maximum of 2 active tokens. Revoke one first.");

      for (const token of existing) {
        expect((await app.inject({ method: "GET", url: "/api/notes", headers: bearer(token) })).statusCode).toBe(200);
      }

      await siteLimits.update(admin.id, { apiTokensPerUser: 4 });
      expect((await create("again")).statusCode).toBe(201);
      const overAgain = await create("extra again");
      expect(overAgain.statusCode).toBe(409);
      expect(overAgain.json().error.message).toBe("You already have the maximum of 4 active tokens. Revoke one first.");
    } finally {
      await close();
    }
  });

  it("OAuth consent decision: after lowering the limit to 2 -> 409 token_limit with the current value in the message", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    try {
      const admin = await seedUser(db, { isAdmin: true });
      const { cookie, userId } = await createUserAndLogin(db);
      await fillPats(db, userId, 2);
      await siteLimits.update(admin.id, { apiTokensPerUser: 2 });
      const req = await startFlow(app);
      const res = await app.inject({ method: "POST", url: "/api/oauth/decision", headers: { cookie }, payload: { req, decision: "allow", scope: FULL } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("token_limit");
      expect(res.json().error.message).toBe("You already have the maximum of 2 active tokens. Revoke one first.");
    } finally {
      await close();
    }
  });

  it("OAuth token exchange: limit lowered to 2 after consent with 2 already existing -> invalid_grant with the current value in the message", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    try {
      const admin = await seedUser(db, { isAdmin: true });
      const { cookie, userId } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      await fillPats(db, userId, 2);
      await siteLimits.update(admin.id, { apiTokensPerUser: 2 });
      const rejected = await exchange(app, codeGrant(c));
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toBe("invalid_grant");
      expect(rejected.json().error_description).toBe("Token limit reached: you already have 2 active tokens. Revoke one first.");
      expect(await db.select().from(apiTokens)).toHaveLength(2);
    } finally {
      await close();
    }
  });
});
