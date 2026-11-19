import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { normalizeScope, TOKEN_SCOPES, type ApiTokenDto, type CreatedApiTokenDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { generateAccessToken, hashToken } from "../auth/api-token.js";
import { AGENT_LABEL_RE, agentLabelOf } from "../auth/agent-label.js";
import { UUID_RE } from "../notes/service.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { countBillableGrants } from "../auth/grant-quota.js";
import type { SiteLimits } from "../site-limits/store.js";

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  scope: z.enum([...TOKEN_SCOPES, "notes:write"]),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});

// AGENT_LABEL_RE already rejects NUL and empty; the object-level "at least one key" refine comes after field validation. The "notes:write" alias is POST-only.
const patchBodySchema = z
  .object({ agentLabel: z.string().regex(AGENT_LABEL_RE).nullable().optional(), scope: z.enum(TOKEN_SCOPES).optional() })
  .strict()
  .refine(b => b.agentLabel !== undefined || b.scope !== undefined);

function toDto(row: typeof apiTokens.$inferSelect): ApiTokenDto {
  return {
    id: row.id,
    // scope goes through normalizeScope so a drifted CHECK degrades to a valid form no larger than stored (fail-closed).
    kind: row.kind as ApiTokenDto["kind"],
    name: row.name,
    agentLabel: agentLabelOf(row),
    scope: normalizeScope(row.scope),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.accessExpiresAt?.toISOString() ?? null,
    clientId: row.clientId,
  };
}

export interface ApiTokensRouteDeps {
  db: Db;
  siteLimits: SiteLimits;
  limiters: { patCreate: FixedWindowLimiter; tokenRename: FixedWindowLimiter };
}

/** Cookie-session only (not authenticateAny): a token must not issue, re-scope or revoke tokens, or a leaked one could perpetuate itself. */
export function apiTokensRoutes(deps: ApiTokensRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/tokens", { preHandler: app.authenticate }, async request => {
      const rows = await deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.userId, request.user!.id))
        .orderBy(desc(apiTokens.createdAt));
      return { tokens: rows.map(toDto) };
    });

    app.post("/api/auth/tokens", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      // Before the limiter, so the rejected request doesn't use quota.
      if (request.user!.mustChangePassword) {
        return sendError(reply, 403, "forbidden", "Change your password before doing this.");
      }
      const userId = request.user!.id;
      if (!deps.limiters.patCreate.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many tokens created. Wait a moment and try again.");
      }

      await runOauthCleanup(deps.db);
      const tokenLimit = deps.siteLimits.get("apiTokensPerUser");
      if ((await countBillableGrants(deps.db, userId)) >= tokenLimit) {
        return sendError(reply, 409, "token_limit", `You already have the maximum of ${tokenLimit} active tokens. Revoke one first.`);
      }

      const plaintext = generateAccessToken();
      const expiresAt =
        parsed.data.expiresInDays === null ? null : new Date(Date.now() + parsed.data.expiresInDays * 86_400_000);
      const [row] = await deps.db
        .insert(apiTokens)
        .values({
          userId,
          kind: "pat",
          name: parsed.data.name,
          scope: normalizeScope(parsed.data.scope),
          accessTokenHash: hashToken(plaintext),
          accessExpiresAt: expiresAt,
        })
        .returning();

      const body: CreatedApiTokenDto = { ...toDto(row), token: plaintext };
      return reply.code(201).send(body);
    });

    /**
     * The limiter runs before the UPDATE and ignores the outcome (a 404 for another user's token still counts), unlike DELETE and POST /api/notes.
     * `agentLabel: null` clears the column rather than storing the derived value. `scope` can go up or down and applies from the next request; refresh doesn't touch it.
     */
    app.patch("/api/auth/tokens/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) return sendError(reply, 404, "token_not_found", "No API token with that id.");
      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        const message = field === "agentLabel" ? "Invalid agentLabel." : field === "scope" ? "Invalid scope." : "Invalid request body.";
        return sendError(reply, 400, "invalid_body", message);
      }
      if (parsed.data.scope !== undefined && request.user!.mustChangePassword) {
        return sendError(reply, 403, "forbidden", "Change your password before doing this.");
      }
      if (!deps.limiters.tokenRename.consume(request.user!.id)) {
        return sendError(reply, 429, "too_many_requests", "Too many changes. Wait a moment and try again.");
      }
      const set: Partial<typeof apiTokens.$inferInsert> = {};
      if (parsed.data.agentLabel !== undefined) set.agentLabel = parsed.data.agentLabel;
      if (parsed.data.scope !== undefined) set.scope = parsed.data.scope;
      const [row] = await deps.db
        .update(apiTokens)
        .set(set)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, request.user!.id)))
        .returning();
      if (!row) return sendError(reply, 404, "token_not_found", "No API token with that id.");
      return reply.send(toDto(row));
    });

    app.delete("/api/auth/tokens/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) return sendError(reply, 404, "token_not_found", "No API token with that id.");
      // `AND user_id=$me` makes another user's token the same 404 as a missing one.
      const deleted = await deps.db
        .delete(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, request.user!.id)))
        .returning({ id: apiTokens.id });
      if (deleted.length === 0) return sendError(reply, 404, "token_not_found", "No API token with that id.");
      return reply.code(204).send();
    });
  };
}
