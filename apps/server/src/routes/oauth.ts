import { randomBytes } from "node:crypto";
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { normalizeScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests, users } from "../db/schema.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import type { UserGate } from "../auth/session.js";
import { generateAccessToken, generateRefreshToken, hashToken, REFRESH_TOKEN_PREFIX } from "../auth/api-token.js";
import { countBillableGrants } from "../auth/grant-quota.js";
import type { SiteLimits } from "../site-limits/store.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { BODY_TOO_LARGE_MESSAGE } from "../http/errors.js";
import { sendOauthError } from "../http/oauth-errors.js";
import { isLoopbackRedirectUri, matchesLoopbackRedirect } from "../oauth/redirect.js";
import { canonicalResource, isCanonicalResource } from "../oauth/resource.js";
import { hasUnstorableChar } from "../oauth/storable.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { verifyPkce } from "../oauth/pkce.js";
import { DEFAULT_CLIENT_NAME, hasUnsafeClientNameChar } from "../oauth/client-name.js";

export interface OauthRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
  gate: UserGate;
  limiters: { dcr: FixedWindowLimiter; authorize: FixedWindowLimiter; tokenEndpoint: FixedWindowLimiter };
}

// ⚠ Only inside prefixed encapsulated plugins: http/spa.ts owns the root setNotFoundHandler and a second one crashes at boot.
export function registerRfcErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // formbody's 415 must stay 415.
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error, authKind: request.authKind }, "oauth endpoint error");
      return sendOauthError(reply, 500, "server_error", "Internal server error.");
    }
    return sendOauthError(reply, status, "invalid_request", status === 413 ? BODY_TOO_LARGE_MESSAGE : error.message || "Bad request.");
  });

  app.setNotFoundHandler(async (_request, reply) => sendOauthError(reply, 404, "invalid_request", "Unknown endpoint."));
}

// Not strict: RFC 7591 lets the server ignore unknown client metadata; extra fields are dropped and never echoed.
const registerBodySchema = z.object({
  client_name: z.string().trim().min(1).max(64).optional(),
  redirect_uris: z.array(z.string().max(512)).min(1).max(8),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  application_type: z.string().optional(),
});

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_STATE = 2048;
const MAX_SCOPE = 512;
const MAX_RESOURCE = 512;
const MAX_REDIRECT_URI = 512;
const MAX_CLIENT_ID = 64;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

// Fully static: the inputs are attacker-controlled. A client whose client_id was cleaned up lands here, so the message must be actionable.
const UNKNOWN_CLIENT_MESSAGE = [
  "這個應用程式在 Knotebook 的註冊已失效或不存在。請在你的用戶端移除後重新加入（例如 `claude mcp remove knotebook` 再 `claude mcp add …`），它會重新註冊。",
  "This application's registration with Knotebook has expired or does not exist. Remove it from your client and add it again (for example `claude mcp remove knotebook` then `claude mcp add …`) so that it re-registers.",
].join("\n\n");

const T1_MESSAGE =
  "授權請求缺少必要參數或參數過長。\n\nThe authorization request is missing required parameters or they are too long.";
const RATE_LIMITED_MESSAGE =
  "授權請求太頻繁，請稍後再試。\n\nToo many authorization requests. Try again later.";

function sendPlainText(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply
    .code(statusCode)
    .header("content-type", "text/plain; charset=utf-8")
    .header("cache-control", "no-store")
    .send(message);
}

function redirectWithError(
  reply: FastifyReply,
  redirectUri: string,
  issuer: string,
  error: string,
  description: string,
  state: string | undefined
): FastifyReply {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return reply.code(302).header("location", url.toString()).header("cache-control", "no-store").send();
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const ACCESS_TTL_MS = 24 * 60 * 60_000;
const OAUTH_USER_CLIENT_UIDX = "api_tokens_oauth_user_client_uidx";

// Only code_verifier has a real minimum (43, RFC 7636): failing later at the PKCE compare would return invalid_grant and make clients rerun the flow. Malformed code/refresh_token are invalid_grant's job (hash lookup / prefix check), so they get no meaningful minimum.
const TOKEN_FIELD_LIMITS: Record<string, { min: number; max: number }> = {
  code: { min: 1, max: 43 },
  code_verifier: { min: 43, max: 128 },
  refresh_token: { min: 1, max: 48 },
  client_id: { min: 1, max: 64 },
  redirect_uri: { min: 1, max: 512 },
  resource: { min: 1, max: 512 },
  grant_type: { min: 1, max: 32 },
};
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

// Failures inside the tx must throw: drizzle rolls back only on throw, so a returned failure would commit the old grant's DELETE together with the code consumption.
class OauthGrantError extends Error {
  constructor(
    readonly code: string,
    readonly description: string
  ) {
    super(description);
  }
}

function formField(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

export function oauthRoutes(deps: OauthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    registerRfcErrorHandlers(app);

    app.post("/register", async (request, reply) => {
      if (!deps.limiters.dcr.consume(request.ip)) {
        return sendOauthError(reply, 429, "invalid_request", "Too many client registrations. Wait a moment and try again.");
      }

      const parsed = registerBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const aboutRedirect = parsed.error.issues.some(issue => issue.path[0] === "redirect_uris");
        return sendOauthError(
          reply,
          400,
          aboutRedirect ? "invalid_redirect_uri" : "invalid_client_metadata",
          aboutRedirect ? "redirect_uris is malformed." : "The client metadata is malformed."
        );
      }
      const body = parsed.data;

      // Unauthenticated DCR with remote redirects would allow one-click phishing under a chosen name.
      if (!body.redirect_uris.every(isLoopbackRedirectUri)) {
        return sendOauthError(
          reply,
          400,
          "invalid_redirect_uri",
          "redirect_uri must be a loopback address with no query, fragment or credentials."
        );
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        return sendOauthError(reply, 400, "invalid_client_metadata", "Only token_endpoint_auth_method=none is supported.");
      }
      if (
        body.grant_types !== undefined &&
        !body.grant_types.every(grant => (SUPPORTED_GRANT_TYPES as readonly string[]).includes(grant))
      ) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "Unsupported grant_types.");
      }
      if (body.response_types !== undefined && (body.response_types.length !== 1 || body.response_types[0] !== "code")) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "Only response_types=[code] is supported.");
      }
      const clientName = body.client_name ?? DEFAULT_CLIENT_NAME;
      if (hasUnsafeClientNameChar(clientName)) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "client_name contains control characters.");
      }

      await runOauthCleanup(deps.db);

      const clientId = randomBytes(16).toString("base64url");
      const [row] = await deps.db
        .insert(oauthClients)
        .values({ clientId, clientName, redirectUris: body.redirect_uris })
        .returning();

      return reply.code(201).header("cache-control", "no-store").header("pragma", "no-cache").send({
        client_id: row!.clientId,
        client_name: row!.clientName,
        redirect_uris: row!.redirectUris,
        grant_types: [...SUPPORTED_GRANT_TYPES],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
      });
    });

    app.get("/authorize", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const clientId = queryString(query.client_id);
      const redirectUri = queryString(query.redirect_uri);

      if (
        clientId === undefined ||
        clientId.length > MAX_CLIENT_ID ||
        redirectUri === undefined ||
        redirectUri.length > MAX_REDIRECT_URI
      ) {
        return sendPlainText(reply, 400, T1_MESSAGE);
      }

      if (!deps.limiters.authorize.consume(request.ip)) {
        return sendPlainText(reply, 429, RATE_LIMITED_MESSAGE);
      }

      // Cleanup before the client lookup, else a cleaned-up client hits an FK error (500) when creating the request.
      await runOauthCleanup(deps.db);

      // client_id is the only request string that reaches a SQL predicate; NUL gives PG 22021 (500). It can't match a registered base64url value anyway.
      if (hasUnstorableChar(clientId)) {
        return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
      }

      const [client] = await deps.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
      if (client === undefined || !client.redirectUris.some(uri => matchesLoopbackRedirect(uri, redirectUri))) {
        return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
      }

      const issuer = publicUrlIssuer(deps.config.publicUrl);
      const rawState = queryString(query.state);
      const stateOk = rawState !== undefined && rawState.length <= MAX_STATE && !hasUnstorableChar(rawState);
      const state = stateOk ? rawState : undefined;
      const fail = (error: string, description: string): FastifyReply =>
        redirectWithError(reply, redirectUri, issuer, error, description, state);

      if (queryString(query.response_type) !== "code") {
        return fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      const codeChallenge = queryString(query.code_challenge);
      if (codeChallenge === undefined || !CODE_CHALLENGE_RE.test(codeChallenge)) {
        return fail("invalid_request", "code_challenge must be 43 to 128 base64url characters.");
      }
      if (queryString(query.code_challenge_method) !== "S256") {
        return fail("invalid_request", "Only code_challenge_method=S256 is supported.");
      }
      if (rawState !== undefined && rawState.length > MAX_STATE) {
        return fail("invalid_request", "state is too long.");
      }
      if (rawState !== undefined && hasUnstorableChar(rawState)) {
        return fail("invalid_request", "state contains characters that can't be stored.");
      }
      const rawScope = queryString(query.scope);
      if (rawScope !== undefined && rawScope.length > MAX_SCOPE) {
        return fail("invalid_request", "scope is too long.");
      }
      const resource = queryString(query.resource);
      if (resource !== undefined && resource.length > MAX_RESOURCE) {
        return fail("invalid_request", "resource is too long.");
      }
      if (!isCanonicalResource(resource, issuer)) {
        return fail("invalid_target", `resource must be ${canonicalResource(issuer)}.`);
      }

      const id = randomBytes(16).toString("base64url");
      try {
        await deps.db.insert(oauthRequests).values({
          id,
          clientId,
          // The full value sent this time (with ephemeral port); the token exchange compares against it.
          redirectUri,
          codeChallenge,
          scope: normalizeScope(rawScope),
          state: state ?? null,
          expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        });
      } catch (err) {
        // Race with zombie-client cleanup at the 24h/30d boundary: show the help page instead of an FK 500. No test (not reproducible).
        if (isForeignKeyViolation(err)) return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
        throw err;
      }

      return reply.code(302).header("location", `/authorize?req=${id}`).header("cache-control", "no-store").send();
    });

    app.post("/token", async (request, reply) => {
      // Set before the limiter so 429s carry them too.
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (!deps.limiters.tokenEndpoint.consume(request.ip)) {
        return sendOauthError(reply, 429, "invalid_request", "Too many token requests. Wait a moment and try again.");
      }

      for (const [name, { min, max }] of Object.entries(TOKEN_FIELD_LIMITS)) {
        const value = formField(request.body, name);
        if (value === undefined) continue;
        if (value.length > max || value.length < min) {
          return sendOauthError(reply, 400, "invalid_request", `${name} has an invalid length.`);
        }
      }
      const issuer = publicUrlIssuer(deps.config.publicUrl);
      const grantType = formField(request.body, "grant_type");
      if (grantType === undefined) {
        return sendOauthError(reply, 400, "invalid_request", "Missing grant_type.");
      }

      if (grantType === "authorization_code") {
        const code = formField(request.body, "code");
        const verifier = formField(request.body, "code_verifier");
        const clientId = formField(request.body, "client_id");
        const redirectUri = formField(request.body, "redirect_uri");
        const resource = formField(request.body, "resource");
        if (code === undefined || verifier === undefined || clientId === undefined || redirectUri === undefined) {
          return sendOauthError(reply, 400, "invalid_request", "A required parameter is missing.");
        }
        if (!CODE_VERIFIER_RE.test(verifier)) {
          return sendOauthError(reply, 400, "invalid_request", "code_verifier has invalid characters.");
        }
        // Missing or invalid resource → invalid_target (RFC 8707 §2.1); invalid_grant would make clients think the code is broken and rerun the whole flow.
        if (!isCanonicalResource(resource, issuer)) {
          return sendOauthError(reply, 400, "invalid_target", `resource must be ${canonicalResource(issuer)}.`);
        }

        // Explicit `=> never` annotation: TS only treats the call as terminating with it; without it, enabling noUncheckedIndexedAccess would break type-checking of this block.
        const invalidGrant: (description?: string) => never = (description = "The authorization code is invalid.") => {
          throw new OauthGrantError("invalid_grant", description);
        };

        try {
          const issued = await deps.db.transaction(async tx => {
            const [consumed] = await tx
              .delete(oauthCodes)
              .where(and(eq(oauthCodes.codeHash, hashToken(code)), sql`${oauthCodes.expiresAt} > now()`))
              .returning();
            // ⚠ These throws roll back the whole tx, so a failed exchange doesn't consume the code; the code is retryable for 10 minutes and PKCE is the only defense (known-limitations).
            if (consumed === undefined) invalidGrant();
            // Compared in JS, not in the SQL predicate: unvalidated request strings stay out of SQL (a NUL would be PG 22021 → 500 on an unauthenticated endpoint).
            if (consumed.clientId !== clientId || consumed.redirectUri !== redirectUri) invalidGrant();
            if (!verifyPkce(verifier, consumed.codeChallenge)) invalidGrant();

            // ⚠ Don't call deps.gate.checkUser inside the tx: on a cache miss it borrows a second pool connection while holding the tx one, so concurrent redemptions can exhaust
            // the pool and hang forever. Read through tx with the same criteria.
            const [account] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, consumed.userId));
            if (account === undefined || account.disabledAt !== null) invalidGrant();

            // Delete the existing (user, client) grant first, then count the quota; carry the renamed agent label over from the deleted row (#106; returning() avoids a second SELECT).
            const [replaced] = await tx
              .delete(apiTokens)
              .where(
                and(eq(apiTokens.userId, consumed.userId), eq(apiTokens.kind, "oauth"), eq(apiTokens.clientId, consumed.clientId))
              )
              .returning({ agentLabel: apiTokens.agentLabel });
            // ⚠ Load-bearing throw: it rolls back the DELETE above; a return value would commit the delete without issuing a token.
            const tokenLimit = deps.siteLimits.get("apiTokensPerUser");
            if ((await countBillableGrants(tx, consumed.userId)) >= tokenLimit) {
              throw new OauthGrantError("invalid_grant", `Token limit reached: you already have ${tokenLimit} active tokens. Revoke one first.`);
            }

            const [client] = await tx.select().from(oauthClients).where(eq(oauthClients.clientId, consumed.clientId));
            if (client === undefined) invalidGrant();

            const accessToken = generateAccessToken();
            const refreshToken = generateRefreshToken();
            await tx.insert(apiTokens).values({
              userId: consumed.userId,
              kind: "oauth",
              name: client.clientName,
              scope: consumed.scope,
              accessTokenHash: hashToken(accessToken),
              refreshTokenHash: hashToken(refreshToken),
              clientId: consumed.clientId,
              accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
              agentLabel: replaced?.agentLabel ?? null,
            });
            await tx.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, consumed.clientId));
            return { accessToken, refreshToken, scope: consumed.scope };
          });

          // ⚠ Fire-and-forget: the tx is committed, and a cleanup error surfacing as 500 would leave the client without a token for a consumed code.
          void runOauthCleanup(deps.db).catch((err: unknown) => {
            request.log.warn({ err }, "oauth cleanup after token exchange failed");
          });
          return reply.send({
            access_token: issued.accessToken,
            token_type: "Bearer",
            expires_in: Math.floor(ACCESS_TTL_MS / 1000),
            refresh_token: issued.refreshToken,
            scope: issued.scope,
          });
        } catch (err) {
          // OauthGrantError first: it has `.code` too, which pg-errors uses to sniff SQLSTATE.
          if (err instanceof OauthGrantError) {
            return sendOauthError(reply, 400, err.code, err.description);
          }
          if (uniqueViolationConstraint(err) === OAUTH_USER_CLIENT_UIDX) {
            return sendOauthError(reply, 400, "invalid_grant", "The authorization code is invalid.");
          }
          throw err;
        }
      }

      if (grantType === "refresh_token") {
        const refreshToken = formField(request.body, "refresh_token");
        const clientId = formField(request.body, "client_id");
        const resource = formField(request.body, "resource");
        if (refreshToken === undefined || clientId === undefined) {
          return sendOauthError(reply, 400, "invalid_request", "A required parameter is missing.");
        }
        if (resource !== undefined && !isCanonicalResource(resource, issuer)) {
          return sendOauthError(reply, 400, "invalid_target", `resource must be ${canonicalResource(issuer)}.`);
        }
        if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
          return sendOauthError(reply, 400, "invalid_grant", "The refresh token is invalid.");
        }

        const [existing] = await deps.db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.refreshTokenHash, hashToken(refreshToken)));
        // Compared in JS, not in the SQL predicate (a NUL would be PG 22021 → 500).
        if (existing === undefined || existing.clientId !== clientId) {
          return sendOauthError(reply, 400, "invalid_grant", "The refresh token is invalid.");
        }
        const gateResult = await deps.gate.checkUser(existing.userId);
        if (gateResult.status !== "ok") {
          return sendOauthError(reply, 400, "invalid_grant", "The refresh token is invalid.");
        }

        const accessToken = generateAccessToken();
        const nextRefresh = generateRefreshToken();
        const rotated = await deps.db
          .update(apiTokens)
          .set({
            accessTokenHash: hashToken(accessToken),
            refreshTokenHash: hashToken(nextRefresh),
            accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
          })
          .where(eq(apiTokens.refreshTokenHash, hashToken(refreshToken)))
          .returning();
        if (rotated.length === 0) {
          return sendOauthError(reply, 400, "invalid_grant", "The refresh token is invalid.");
        }
        await deps.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, existing.clientId));
        void runOauthCleanup(deps.db).catch((err: unknown) => {
          request.log.warn({ err }, "oauth cleanup after refresh failed");
        });

        return reply.send({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: Math.floor(ACCESS_TTL_MS / 1000),
          refresh_token: nextRefresh,
          scope: rotated[0]!.scope,
        });
      }

      return sendOauthError(reply, 400, "unsupported_grant_type", "Unsupported grant_type.");
    });
  };
}
