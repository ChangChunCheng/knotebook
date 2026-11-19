// Logs and responses never contain the token or token_hash (the 201 returns the token once).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { hashToken } from "../auth/api-token.js";
import { generateOneTimeToken } from "../auth/one-time-link.js";
import { deleteEndedOneTimeLinks } from "../auth/one-time-link-cleanup.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { cancelPasswordResetsInTx, issuePasswordResetInTx } from "../auth/tx/password-reset.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { UUID_RE } from "../notes/service.js";

const issueBodySchema = z.object({ expiresInHours: z.number().int().min(1).max(24) }).strict();

export interface AdminPasswordResetRouteDeps {
  db: Db;
  config: Pick<AppConfig, "passwordLoginForceEnable">;
}

export function adminPasswordResetRoutes(deps: AdminPasswordResetRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/admin/users/:id/password-reset", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "No user with that id.");
      const id = rawId.toLowerCase();
      const parsed = issueBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const token = generateOneTimeToken("password_reset");
      const input = { targetUserId: id, createdById: request.user!.id, tokenHash: hashToken(token), expiresInHours: parsed.data.expiresInHours };
      let issued: { linkId: string; expiresAt: Date; replaced: number };
      try {
        issued = await deps.db.transaction(tx => issuePasswordResetInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // INSERT params carry token_hash; redact so it doesn't reach the log.
        throw redactDbError(request.log, err, "產生重設密碼連結");
      }
      const { linkId, expiresAt, replaced } = issued;
      request.log.info({ userId: request.user!.id, targetUserId: id, linkId, expiresAt, replaced }, "產生重設密碼連結");
      // No scheduler: opportunistic cleanup; failure doesn't affect the response.
      void deleteEndedOneTimeLinks(deps.db).catch((err: unknown) => request.log.warn({ err }, "清理一次性連結失敗"));
      return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
    });

    // Cancelling ignores the password-login switch and disabled state.
    app.delete("/api/admin/users/:id/password-reset", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "No user with that id.");
      const input = { targetUserId: rawId.toLowerCase() };
      let revoked: number;
      try {
        ({ revoked } = await deps.db.transaction(tx => cancelPasswordResetsInTx(tx, input)));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw redactDbError(request.log, err, "取消重設密碼連結");
      }
      request.log.info({ userId: request.user!.id, targetUserId: input.targetUserId, revoked }, "取消重設密碼連結");
      return reply.code(204).send();
    });
  };
}
