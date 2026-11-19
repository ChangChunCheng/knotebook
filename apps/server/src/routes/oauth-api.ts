import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { narrowerScope, normalizeScope, TOKEN_SCOPES, type OauthRequestDto, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { hashToken } from "../auth/api-token.js";
import { countBillableGrants } from "../auth/grant-quota.js";
import type { SiteLimits } from "../site-limits/store.js";
import { matchesLoopbackRedirect } from "../oauth/redirect.js";
import { runOauthCleanup } from "../oauth/cleanup.js";

const CODE_TTL_MS = 10 * 60_000;

// `req` goes into a SQL predicate: it must match the 22-char base64url shape first; anything else looks like "used or expired".
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{22}$/;

// allow requires the consent page's `scope` (also rejects stale pre-upgrade tabs); deny ignores it.
const decisionBodySchema = z.discriminatedUnion("decision", [
  z.object({ req: z.string(), decision: z.literal("deny") }),
  z.object({ req: z.string(), decision: z.literal("allow"), scope: z.enum(TOKEN_SCOPES) }),
]);

function splitScopes(scope: TokenScope): string[] {
  return scope.split(" ");
}

function buildRedirect(redirectUri: string, issuer: string, params: Record<string, string>, state: string | null): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export interface OauthApiRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
}

// Top-level app with in-site error shapes (not the RFC plugin): the consumer is our SPA and needs i18n-able errors. No limiter: AUTHORIZE_LIMIT upstream.
export function oauthApiRoutes(deps: OauthApiRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const issuer = publicUrlIssuer(deps.config.publicUrl);

    app.get("/api/oauth/request", { preHandler: app.authenticate }, async (request, reply) => {
      const req = (request.query as { req?: unknown }).req;
      if (typeof req !== "string" || !REQUEST_ID_RE.test(req)) {
        return sendError(reply, 410, "oauth_request_invalid", "This authorization request has been used or has expired.");
      }
      const [row] = await deps.db
        .select({
          redirectUri: oauthRequests.redirectUri,
          scope: oauthRequests.scope,
          clientId: oauthRequests.clientId,
          clientName: oauthClients.clientName,
          redirectUris: oauthClients.redirectUris,
        })
        .from(oauthRequests)
        .innerJoin(oauthClients, eq(oauthRequests.clientId, oauthClients.clientId))
        .where(and(eq(oauthRequests.id, req), sql`${oauthRequests.expiresAt} > now()`));
      if (row === undefined) {
        return sendError(reply, 410, "oauth_request_invalid", "This authorization request has been used or has expired.");
      }
      // The stored value contains an ephemeral port, so no string membership test.
      if (!row.redirectUris.some(uri => matchesLoopbackRedirect(uri, row.redirectUri))) {
        return sendError(reply, 404, "not_found", "No authorization request with that id.");
      }

      // existingScope only seeds the consent page's default checkboxes; decision doesn't depend on it.
      const [existing] = await deps.db
        .select({ scope: apiTokens.scope })
        .from(apiTokens)
        .where(
          and(eq(apiTokens.userId, request.user!.id), eq(apiTokens.kind, "oauth"), eq(apiTokens.clientId, row.clientId))
        );

      const scope = row.scope as TokenScope;
      const body: OauthRequestDto = {
        clientName: row.clientName,
        redirectHost: new URL(row.redirectUri).host,
        scope,
        scopes: splitScopes(scope),
        existingScope: existing === undefined ? null : normalizeScope(existing.scope),
        replacesExisting: existing !== undefined,
      };
      return body;
    });

    app.post("/api/oauth/decision", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = decisionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", "Invalid request body.");
      }
      // Before consumption, so a rejected request doesn't waste the pending request.
      if (request.user!.mustChangePassword) {
        return sendError(reply, 403, "forbidden", "Change your password before doing this.");
      }
      if (!REQUEST_ID_RE.test(parsed.data.req)) {
        return sendError(reply, 410, "oauth_request_invalid", "This authorization request has been used or has expired.");
      }

      // Zombie-client cleanup must precede consumption and the client lookup (a misorder only shows across the 24h boundary; no test catches it).
      await runOauthCleanup(deps.db);

      // allow and deny both consume: a double click creates one code.
      const [pending] = await deps.db
        .delete(oauthRequests)
        // expires_at overlaps the cleanup above (defense in depth).
        .where(and(eq(oauthRequests.id, parsed.data.req), sql`${oauthRequests.expiresAt} > now()`))
        .returning();
      if (pending === undefined) {
        return sendError(reply, 410, "oauth_request_invalid", "This authorization request has been used or has expired.");
      }

      const [client] = await deps.db.select().from(oauthClients).where(eq(oauthClients.clientId, pending.clientId));
      if (client === undefined || !client.redirectUris.some(uri => matchesLoopbackRedirect(uri, pending.redirectUri))) {
        return sendError(reply, 404, "not_found", "No authorization request with that id.");
      }

      if (parsed.data.decision === "deny") {
        return { redirectTo: buildRedirect(pending.redirectUri, issuer, { error: "access_denied" }, pending.state) };
      }

      const userId = request.user!.id;
      const tokenLimit = deps.siteLimits.get("apiTokensPerUser");
      if ((await countBillableGrants(deps.db, userId, pending.clientId)) >= tokenLimit) {
        return sendError(reply, 409, "token_limit", `You already have the maximum of ${tokenLimit} active tokens. Revoke one first.`);
      }

      // granted = requested ∩ checked; a body wider than the pending request is clamped, not an error (move and delete don't form a chain).
      const granted = narrowerScope(pending.scope as TokenScope, parsed.data.scope);
      const code = randomBytes(32).toString("base64url");
      await deps.db.insert(oauthCodes).values({
        codeHash: hashToken(code),
        clientId: pending.clientId,
        userId,
        scope: granted,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      // Creating a code counts as client use for zombie cleanup.
      await deps.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, pending.clientId));

      return { redirectTo: buildRedirect(pending.redirectUri, issuer, { code }, pending.state) };
    });
  };
}
