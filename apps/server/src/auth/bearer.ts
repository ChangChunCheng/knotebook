import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { hasScope, normalizeScope, type RequiredScope, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, oauthClients } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";
import { buildBearerChallenge } from "./challenge.js";
import { hashToken, isAccessTokenShape, parseAuthorizationHeader } from "./api-token.js";
import type { ResolvedSession, UserGate } from "./session.js";

export interface BearerDeps {
  db: Db;
  gate: UserGate;
  issuer: string;
  resolveSessionUser: (request: FastifyRequest) => Promise<ResolvedSession | null>;
  limiters: {
    bearerMiss: FixedWindowLimiter;
    tokenRead: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
  };
}

const LAST_USED_THROTTLE_MS = 60_000;

/**
  * Opt-in: only routes mounting this accept API tokens, so a leaked token can read/write notes but not take over the account.
  * `required` is the single value for the authorization check (`hasScope(stored, required)`); `challenge` is the scope set
  * advertised in WWW-Authenticate (default `required`; see `auth/challenge.ts`). With an Authorization header only the token
  * path runs, with no cookie fallback (the web client never sends it). Don't call `app.authenticate` for the cookie fallback:
  * `sendError` calls `reply.send()`, so a header set afterwards is silently lost.
 */
export function createAuthenticateAny(deps: BearerDeps) {
  // Per-app instance: a module-level singleton would share state across test files (the last_used_at guard tests would flip with run order).
  // An evicted entry costs only one extra UPDATE, no error path.
  const lastUsedTouchedAt = new BoundedMap<number>(DEFAULT_MAX_KEYS);

  function touchLastUsed(request: FastifyRequest, row: { id: string; clientId: string | null }): void {
    const now = Date.now();
    const previous = lastUsedTouchedAt.get(row.id);
    if (previous !== undefined && now - previous < LAST_USED_THROTTLE_MS) return;
    lastUsedTouchedAt.set(row.id, now);
    const stamp = new Date(now);
    // Fire-and-forget: last_used_at only feeds the settings page and the zombie-client cleanup, so a failed write must not fail the request.
    void (async () => {
      await deps.db.update(apiTokens).set({ lastUsedAt: stamp }).where(eq(apiTokens.id, row.id));
      if (row.clientId !== null) {
        // The zombie-client cleanup uses this timestamp for "unused for 30 days", so it must move with the token's.
        await deps.db.update(oauthClients).set({ lastUsedAt: stamp }).where(eq(oauthClients.clientId, row.clientId));
      }
    })().catch((err: unknown) => {
      request.log.warn({ err, tokenId: row.id }, "failed to update api token last_used_at");
    });
  }

  /** Set headers BEFORE `sendError` (it calls `reply.send()`). Mutation tests can't catch a swapped order: the async global onSend hook masks it. */
  function rejectBearer(request: FastifyRequest, reply: FastifyReply, challenge: string, invalidToken: boolean): void {
    if (!deps.limiters.bearerMiss.consume(request.ip)) {
      // No challenge on 429: RFC 6750 defines it for 400/401/403, and a client re-running authorization would hit the DCR/authorize limiters.
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      return;
    }
    reply.header(
      "www-authenticate",
      buildBearerChallenge({ issuer: deps.issuer, scope: challenge, error: invalidToken ? "invalid_token" : undefined })
    );
    sendError(reply, 401, "unauthorized", invalidToken ? "The token is invalid or expired." : "Not signed in.");
  }

  return function authenticateAny(required: RequiredScope, challenge: string = required) {
    return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const rawHeader = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(rawHeader);

      if (parsed.kind === "none") {
        const resolved = await deps.resolveSessionUser(request);
        if (resolved === null) {
          // Challenge even without credentials: an MCP client's first request has none and discovers the auth server from it.
          // RFC 6750 §3: no error code when credentials are absent.
          reply.header("www-authenticate", buildBearerChallenge({ issuer: deps.issuer, scope: challenge }));
          sendError(reply, 401, "unauthorized", "Not signed in.");
          return;
        }
        request.user = resolved.user;
        request.sessionTv = resolved.tv;
        request.sessionId = resolved.sid;
        request.authKind = "session";
        return; // a session is a full identity: no scope check, no token bucket
      }

      // RFC 6750 §3: an unsupported scheme (e.g. Basic) gets no error code.
      if (parsed.kind === "other-scheme") return rejectBearer(request, reply, challenge, false);

      // Wrong prefix: skip the DB (a refresh token sent as Bearer lands here).
      if (!isAccessTokenShape(parsed.token)) return rejectBearer(request, reply, challenge, true);

      const [row] = await deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.accessTokenHash, hashToken(parsed.token)))
        .limit(1);
      if (row === undefined) return rejectBearer(request, reply, challenge, true);

      // No `kind` in the predicate: default PATs have NULL expiry, and the quota predicate's `kind='oauth' OR` would keep expired oauth tokens valid.
      if (row.accessExpiresAt !== null && row.accessExpiresAt.getTime() <= Date.now()) {
        return rejectBearer(request, reply, challenge, true);
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok") return rejectBearer(request, reply, challenge, true);
      // Must-change-password users can't bypass via token (`UserGate.evaluate` ignores the flag).
      if (gateResult.user.mustChangePassword) return rejectBearer(request, reply, challenge, true);

      // 403 consumes neither bearerMiss (a valid token retrying must not penalize its IP) nor the token bucket (charged only after this check).
      if (!hasScope(row.scope as TokenScope, required)) {
        reply.header(
          "www-authenticate",
          buildBearerChallenge({ issuer: deps.issuer, scope: challenge, error: "insufficient_scope" })
        );
        sendError(reply, 403, "insufficient_scope", "This token's scope doesn't allow this action.");
        return;
      }

      // `/api/mcp` declares `notes:read` but a request may write, so tokenWrite is charged in each write tool (`mcp/write-scope.ts`).
      const bucket = required === "notes:write" ? deps.limiters.tokenWrite : deps.limiters.tokenRead;
      if (!bucket.consume(`token:${row.userId}`)) {
        sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "token";
      // normalizeScope, not a cast: if the CHECK drifts this degrades to read-only (fail-closed). The cast at `hasScope` above is deliberate: a membership check over the text column.
      request.tokenScope = normalizeScope(row.scope);
      request.tokenId = row.id;
      touchLastUsed(request, { id: row.id, clientId: row.clientId });
    };
  };
}
