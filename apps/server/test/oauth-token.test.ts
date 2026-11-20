/**
 * The exchange steps of the authorization_code branch are a **single transaction** and any failure rolls back (leaving neither
 * "code eaten but no token" nor "old grant deleted without issuing a new one"); `invalid_target` must not be written as
 * `invalid_grant` (the client would misjudge the code as broken and rerun the whole flow).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { apiTokens, oauthClients, oauthCodes, users } from "../src/db/schema.js";
import { UserGate } from "../src/auth/session.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, createUserAndLogin, freshDb, freshLimiters } from "./helpers.js";
import { ISSUER, RESOURCE, authorizeAndConsent, codeGrant, exchange, obtainCode } from "./helpers/oauth-flow.js";

const NUL = String.fromCharCode(0);

describe("POST /oauth/token - authorization_code", () => {
  it("exchange succeeds: returns access/refresh/scope, headers carry no-store and pragma", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: "notes:write" });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
      const body = res.json();
      expect(body.access_token).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
      expect(body.refresh_token).toMatch(/^knbr_[A-Za-z0-9_-]{43}$/);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(86400);
      expect(body.scope).toBe("notes:read notes:write");

      // grant stored: kind=oauth, name is the client_name snapshot, plaintext not stored, access 24 h
      const [row] = await db.select().from(apiTokens);
      expect(row!.kind).toBe("oauth");
      expect(row!.name).toBe("Test client");
      expect(row!.clientId).toBe(c.clientId);
      expect(row!.accessTokenHash).not.toBe(body.access_token);
      expect(row!.refreshTokenHash).not.toBe(body.refresh_token);
      const ttl = row!.accessExpiresAt!.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(23 * 3600_000);
      expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
      // code consumed
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("the exchanged access token can hit allowlisted routes; the client's last_used_at is updated", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const stale = new Date(Date.now() - 10 * 86_400_000);
      await db.update(oauthClients).set({ lastUsedAt: stale }).where(sql`${oauthClients.clientId} = ${c.clientId}`);

      const token = (await exchange(app, codeGrant(c))).json().access_token as string;
      // Assert before the Bearer request: the Bearer path (touchLastUsed) also updates this column, so asserting after would stay
      // green with the token endpoint's final UPDATE removed.
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());

      const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  // The last link of the whole flow: oauth grants can also be revoked from the settings page and are invalid at once. This case covers an oauth grant
  // (the query is kind-agnostic, but without a case it could drift).
  it("revoking an oauth grant -> that access token is 401 at once", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const token = (await exchange(app, codeGrant(c))).json().access_token as string;
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

      const [row] = await db.select({ id: apiTokens.id }).from(apiTokens);
      const revoked = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${row!.id}`, headers: { cookie } });
      expect(revoked.statusCode).toBe(204);

      const after = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
      expect(after.statusCode).toBe(401);
      expect(after.headers["www-authenticate"]).toContain('error="invalid_token"');
    } finally {
      await close();
    }
  });

  it("code used twice -> invalid_grant", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
      const replay = await exchange(app, codeGrant(c));
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toEqual({ error: "invalid_grant", error_description: "The authorization code is invalid." });
      // Replay doesn't revoke the already signed grant (deliberately not done)
      expect(await db.select().from(apiTokens)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // A failed exchange rolls back the whole transaction = **doesn't consume the code**; the same code can be retried with corrected parameters.
  it("PKCE mismatch / client_id mismatch / redirect_uri mismatch -> invalid_grant, and the code remains (transaction rolled back)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const overrides: Array<Record<string, string>> = [
        { code_verifier: randomBytes(32).toString("base64url") },
        { client_id: "someone-else" },
        { redirect_uri: "http://127.0.0.1:5678/other" },
        // A different port from registration is fine, but the code is bound to the full value from that authorize (including the port)
        { redirect_uri: "http://127.0.0.1:1234/cb" },
      ];
      for (const override of overrides) {
        const res = await exchange(app, { ...codeGrant(c), ...override });
        expect(res.statusCode, JSON.stringify(override)).toBe(400);
        expect(res.json().error, JSON.stringify(override)).toBe("invalid_grant");
        expect(await db.select().from(oauthCodes), JSON.stringify(override)).toHaveLength(1);
        expect(await db.select().from(apiTokens), JSON.stringify(override)).toHaveLength(0);
      }
      // Positive control: the same code, parameters corrected, can still be exchanged
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("wrong or missing resource -> invalid_target (not invalid_grant), and the code isn't consumed", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const wrong = await exchange(app, { ...codeGrant(c), resource: `${ISSUER}/api/other` });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toBe("invalid_target");
      const { resource: _dropped, ...withoutResource } = codeGrant(c);
      void _dropped;
      const missing = await exchange(app, withoutResource);
      expect(missing.json().error).toBe("invalid_target");
      // the resource check runs before the transaction, the code is untouched
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("expired code -> invalid_grant", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      await db.update(oauthCodes).set({ expiresAt: sql`now() - interval '1 minute'` });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
    } finally {
      await close();
    }
  });

  // Doesn't use the gate cache: the exchange reads the users row directly inside the transaction, so a disabled user must be refused
  // **without invalidate**; this case also pins "don't go back to the pool inside the transaction" (switching back to
  // gate.checkUser would read the 60 s cached ok and go green).
  it("user disabled -> invalid_grant, code not consumed (bypassing the gate cache)", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    const { app, close } = await buildTestApp({ db, gate });
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      await db.update(users).set({ disabledAt: new Date() }).where(sql`${users.id} = ${userId}`);
      expect(await gate.checkUser(userId)).toMatchObject({ status: "ok" });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // Load-bearing: when quota is insufficient the whole transaction must ROLLBACK. If failure were expressed as a return value inside
  // the transaction (drizzle rolls back only on throw), the DELETE of the old grant would be committed = the old authorization swallowed without a new token.
  it("refusing to issue for insufficient quota leaves the client's existing grant untouched (transaction rolled back)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstBody = (await exchange(app, codeGrant(first))).json();
      expect(firstBody.access_token).toMatch(/^knb_/);

      // Run another authorization round for the same client (quota isn't full yet, so decision passes)
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);

      // The quota **must be filled after consent and before the exchange**: the quota rule makes decision's and token's quota queries
      // equivalent, so no PAT count lets decision pass while token refuses; the only reachable path for "token side refuses" is the
      // quota being consumed between consent and exchange.
      await db.insert(apiTokens).values(
        Array.from({ length: 20 }, (_, i) => ({
          userId,
          kind: "pat" as const,
          name: `pat${i}`,
          scope: "notes:read" as const,
          accessTokenHash: `pat-${i}`,
          accessExpiresAt: null,
        }))
      );

      const rejected = await exchange(app, codeGrant({ ...first, ...second }));
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toBe("invalid_grant");
      expect(rejected.json().error_description).toMatch(/^Token limit reached: you already have \d+ active tokens\. Revoke one first\.$/);
      // Key: the old grant is still there, the old access still works, and the code remains
      const survivors = await db.select().from(apiTokens).where(sql`${apiTokens.clientId} = ${first.clientId}`);
      expect(survivors).toHaveLength(1);
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
      const stillWorks = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${firstBody.access_token}` },
      });
      expect(stillWorks.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  // Cross-feature case: 20 grants with one belonging to this client -> the quota deductions on both sides are equivalent and re-authorization still succeeds
  it("20 grants where one belongs to this client: re-authorization still succeeds, the client still has exactly one row, the old access is 401", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstBody = (await exchange(app, codeGrant(first))).json();
      // Add 19 more PATs -> 20 counted grants (including this client's)
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
      // decision side's deduction predicate (authorizeAndConsent asserts 200 inside)
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);
      // token side's "delete first, then count"
      const res = await exchange(app, codeGrant({ ...first, ...second }));
      expect(res.statusCode).toBe(200);

      const oauthRows = await db.select().from(apiTokens).where(sql`${apiTokens.clientId} = ${first.clientId}`);
      expect(oauthRows).toHaveLength(1); // no accumulation into two rows
      const old = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${firstBody.access_token}` },
      });
      expect(old.statusCode).toBe(401); // the old access has been replaced
    } finally {
      await close();
    }
  });

  it("a second authorization for the same client leaves one row; the old access is 401 at once, the new one 200", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstToken = (await exchange(app, codeGrant(first))).json().access_token as string;
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);
      const secondToken = (await exchange(app, codeGrant({ ...first, ...second }))).json().access_token as string;

      expect(await db.select().from(apiTokens)).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${firstToken}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${secondToken}` } })).statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("after success the opportunistic cleanup runs: a zombie client from 25 hours ago disappears after this request", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      // The zombie must be inserted **after** obtainCode: DCR/authorize/decision each run the opportunistic cleanup, so inserting
      // earlier would get it cleaned by them and removing the token endpoint's own cleanup would stay green (false green).
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
      // The opportunistic cleanup (`runOauthCleanup`) is fire-and-forget: poll with a deadline, a fixed sleep is flaky on WSL containers
      await expect
        .poll(async () => (await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id), {
          timeout: 3_000,
          interval: 25,
        })
        .not.toContain("zombie");
    } finally {
      await close();
    }
  });

  it("re-authorization after a rename (authorization_code exchange, delete-then-insert) -> the new row's agent_label is still the renamed value", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db); // this helper returns the complete cookie string
      const first = await obtainCode(app, cookie);
      expect((await exchange(app, codeGrant(first))).statusCode).toBe(200);
      const [row0] = await db.select({ id: apiTokens.id }).from(apiTokens);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/auth/tokens/${row0!.id}`,
            headers: { cookie },
            payload: { agentLabel: "my-agent" },
          })
        ).statusCode
      ).toBe(200);

      // The second authorization **must reuse the first client_id** (only authorizeAndConsent, no second DCR): with a different
      // client_id this wouldn't be the delete-then-insert path and the case guards nothing.
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);
      expect((await exchange(app, codeGrant({ ...first, ...second }))).statusCode).toBe(200);

      const rows = await db.select({ id: apiTokens.id, label: apiTokens.agentLabel }).from(apiTokens);
      expect(rows).toHaveLength(1); // no accumulation into two rows
      expect(rows[0]!.id).not.toBe(row0!.id); // really a new row (not the original updated)
      expect(rows[0]!.label).toBe("my-agent"); // the name the user set was carried over
    } finally {
      await close();
    }
  });
});

describe("POST /oauth/token - refresh_token", () => {
  it("rotation succeeds; the old refresh is invalid_grant at once; scope carries over", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: "notes:write" });
      const first = (await exchange(app, codeGrant(c))).json();
      const stale = new Date(Date.now() - 10 * 86_400_000);
      await db.update(oauthClients).set({ lastUsedAt: stale }).where(sql`${oauthClients.clientId} = ${c.clientId}`);

      const rotated = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.headers["cache-control"]).toBe("no-store");
      expect(rotated.json().refresh_token).not.toBe(first.refresh_token);
      expect(rotated.json().access_token).not.toBe(first.access_token);
      expect(rotated.json().scope).toBe("notes:read notes:write");
      expect(rotated.json().expires_in).toBe(86400);
      expect(await db.select().from(apiTokens)).toHaveLength(1); // rotation isn't a new row
      // Rotation is one of the "uses" counted by idle-client delete (the refresh path updates last_used_at)
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());

      const replay = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_grant");
      // The old access is invalidated by the rotation too (two tokens exchanged at once)
      const oldAccess = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${first.access_token}` },
      });
      expect(oldAccess.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  // (#239 regression guard) exchange returns the grant decision clamped; refresh doesn't touch scope: a value changed on the row is returned as is.
  it("#239: requested read/write/move, ticked only read/write -> exchange returns read/write; after the row is changed to read/write/move, refresh returns read/write/move and the row id is unchanged", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: "notes:read notes:write notes:move", grant: "notes:read notes:write" });
      const first = await exchange(app, codeGrant(c));
      expect(first.statusCode).toBe(200);
      expect(first.json().scope).toBe("notes:read notes:write");
      const [before] = await db.select({ id: apiTokens.id }).from(apiTokens);

      await db.update(apiTokens).set({ scope: "notes:read notes:write notes:move" });
      const rotated = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.json().refresh_token as string,
        client_id: c.clientId,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().scope).toBe("notes:read notes:write notes:move");
      const after = await db.select({ id: apiTokens.id }).from(apiTokens);
      expect(after.map(r => r.id)).toEqual([before!.id]);
    } finally {
      await close();
    }
  });

  // read/write/delete is issued as is and refresh rotation leaves scope alone (#181).
  it("#181: requesting and ticking read/write/delete -> exchange returns read/write/delete and so does the row; still read/write/delete after refresh rotation", async () => {
    const RWD = "notes:read notes:write notes:delete";
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: RWD, grant: RWD });
      const first = await exchange(app, codeGrant(c));
      expect(first.statusCode).toBe(200);
      expect(first.json().scope).toBe(RWD);
      expect((await db.select({ scope: apiTokens.scope }).from(apiTokens)).map(r => r.scope)).toEqual([RWD]);
      const rotated = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.json().refresh_token as string,
        client_id: c.clientId,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().scope).toBe(RWD);
      expect((await db.select({ scope: apiTokens.scope }).from(apiTokens)).map(r => r.scope)).toEqual([RWD]);
    } finally {
      await close();
    }
  });

  // The end-to-end half of the grant rule (#181): requested read/write/move, ticked read/write/delete -> intersection read/write, token response and row are both read/write.
  it("#181: requested read/write/move, ticked read/write/delete -> exchange returns read/write, row too", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, {
        scope: "notes:read notes:write notes:move",
        grant: "notes:read notes:write notes:delete",
      });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(200);
      expect(res.json().scope).toBe("notes:read notes:write");
      expect((await db.select({ scope: apiTokens.scope }).from(apiTokens)).map(r => r.scope)).toEqual(["notes:read notes:write"]);
    } finally {
      await close();
    }
  });

  it("refresh still works after access has expired, and the new access is usable at once (Bearer part)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();
      await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 hour'` });

      const expired = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${first.access_token}` },
      });
      expect(expired.statusCode).toBe(401);
      expect(expired.headers["www-authenticate"]).toContain('error="invalid_token"');

      const rotated = (
        await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.clientId })
      ).json();
      const ok = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${rotated.access_token}` },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("client_id mismatch, wrong prefix, not found, user disabled -> invalid_grant; wrong resource -> invalid_target", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    const { app, close } = await buildTestApp({ db, gate });
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();

      const wrongClient = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "other" });
      expect(wrongClient.json().error).toBe("invalid_grant");
      // An access token sent as refresh: wrong prefix, never reaches the DB -> invalid_grant (a malformed credential isn't
      // invalid_request: the length table deliberately has no lower bound, see the note on TOKEN_FIELD_LIMITS)
      const accessAsRefresh = await exchange(app, { grant_type: "refresh_token", refresh_token: first.access_token, client_id: c.clientId });
      expect(accessAsRefresh.json().error).toBe("invalid_grant");
      const unknown = await exchange(app, { grant_type: "refresh_token", refresh_token: `knbr_${"x".repeat(43)}`, client_id: c.clientId });
      expect(unknown.json().error).toBe("invalid_grant");
      const wrongResource = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
        resource: `${ISSUER}/api/other`,
      });
      expect(wrongResource.json().error).toBe("invalid_target");
      // disabled: checkUser fails -> invalid_grant, with no rotation (refresh hash unchanged)
      await db.update(users).set({ disabledAt: new Date() }).where(sql`${users.id} = ${userId}`);
      gate.invalidate(userId);
      const disabled = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.clientId });
      expect(disabled.json().error).toBe("invalid_grant");
      const [row] = await db.select({ h: apiTokens.refreshTokenHash }).from(apiTokens);
      expect(row!.h).toBe(createHash("sha256").update(first.refresh_token as string).digest("hex"));
    } finally {
      await close();
    }
  });

  it("client_id containing NUL -> invalid_grant, not 500 (unstorable strings rejected before SQL)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();
      const res = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: NUL });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json().error).toBe("invalid_grant");
    } finally {
      await close();
    }
  });
});

describe("POST /oauth/token - general", () => {
  it("unknown grant_type -> unsupported_grant_type; missing parameter / bad length -> invalid_request", async () => {
    const { app, close } = await buildTestApp();
    try {
      expect((await exchange(app, { grant_type: "client_credentials" })).json().error).toBe("unsupported_grant_type");
      // A missing grant_type is "missing a required parameter" (RFC 6749 §5.2) -> invalid_request
      expect((await exchange(app, {})).json().error).toBe("invalid_request");
      expect((await exchange(app, { grant_type: "refresh_token", client_id: "c" })).json().error).toBe("invalid_request");
      const tooLong = await exchange(app, { grant_type: "refresh_token", refresh_token: "r".repeat(64), client_id: "c" });
      expect(tooLong.json().error).toBe("invalid_request");
      // code_verifier has a lower bound of 43: too short must be invalid_request, not the invalid_grant of a PKCE failure
      const shortVerifier = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "short",
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(shortVerifier.json().error).toBe("invalid_request");
      // Right length but wrong character set (RFC 7636 §4.1 accepts only unreserved): without CODE_VERIFIER_RE this would become a
      // PKCE-failure invalid_grant and the client would misjudge the code as broken and rerun the whole flow
      const badCharset = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "%".repeat(43),
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(badCharset.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  // Code branch: strings Postgres can't store (NUL, lone surrogates) never reach a SQL predicate: code goes through hashToken first, client_id/redirect_uri
  // are compared with DB rows only in JS, the verifier only goes into sha256. NUL is always a 400 business error.
  it("client_id/code/verifier containing NUL in the code branch -> 400 (not 500)", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const cases: Array<[Record<string, string>, string]> = [
        [{ client_id: NUL }, "invalid_grant"],
        [{ code: `${NUL}${"c".repeat(42)}` }, "invalid_grant"],
        [{ code_verifier: `${NUL}${"v".repeat(42)}` }, "invalid_request"],
      ];
      for (const [override, expected] of cases) {
        const res = await exchange(app, { ...codeGrant(c), ...override });
        expect(res.statusCode, JSON.stringify(override)).toBe(400);
        expect(res.headers["content-type"], JSON.stringify(override)).toContain("application/json");
        expect(res.json().error, JSON.stringify(override)).toBe(expected);
      }
      // None consumed the code (transaction rolled back or never entered)
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // A "broken form body -> 400" case can't be made: @fastify/formbody uses fast-querystring, where `%%%` doesn't throw and just parses
  // to `{"%%%": ""}`, landing on unsupported_grant_type; so that branch of the scoped error handler ("keep formbody's 415") can't be exercised this way.
  // These two cases pin that the guard really consults the `FORM_EXEMPT_ROUTES` list (changing `wantsForm` to
  // always false would otherwise stay green).
  it("form passes the guard (lands on a 400 business error, not 415); JSON -> 415 RFC-shaped", async () => {
    const { app, close } = await buildTestApp();
    try {
      const form = await exchange(app, { grant_type: "bogus" });
      expect(form.statusCode).toBe(400);
      expect(form.json().error).toBe("unsupported_grant_type");

      const json = await app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token" } });
      expect(json.statusCode).toBe(415);
      expect(json.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("GET on this route -> 404 RFC-shaped (a wrong method also goes through the prefix notFound)", async () => {
    const { app, close } = await buildTestApp();
    try {
      const notFound = await app.inject({ method: "GET", url: "/oauth/token" });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("all errors are HTTP 400 (RFC 6749 section 5.2) with no-store/pragma", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "v".repeat(43),
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
    } finally {
      await close();
    }
  });

  it("over the TOKEN_ENDPOINT quota -> 429 RFC-shaped", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ tokenEndpoint: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      await exchange(app, { grant_type: "bogus" });
      await exchange(app, { grant_type: "bogus" });
      const res = await exchange(app, { grant_type: "bogus" });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("invalid_request");
      expect(res.headers.pragma).toBe("no-cache");
    } finally {
      await close();
    }
  });
});
