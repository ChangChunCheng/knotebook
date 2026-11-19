// The token comes only from the POST body (URL fragment only), so no log masking is needed; logs and responses never contain it or token_hash. The password-login switch is checked outside the transaction only.
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { UserDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { oneTimeLinks, users } from "../db/schema.js";
import { hashToken } from "../auth/api-token.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { touchLastLogin } from "../auth/last-login.js";
import { readCurrentAvatar } from "../avatars/read.js";
import { activeOneTimeLink, isOneTimeTokenShape } from "../auth/one-time-link.js";
import { hashPassword, HashBusyError } from "../auth/password.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import type { UserGate } from "../auth/session.js";
import { setSessionCookieFor } from "../auth/sessions.js";
import { completePasswordResetInTx, RESET_LINK_INVALID_MESSAGE } from "../auth/tx/password-reset.js";
import type { CollabHooks } from "../collab/hooks.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";

const inspectBodySchema = z.object({ token: z.string() }).strict();
const completeBodySchema = z.object({ token: z.string(), newPassword: z.string() }).strict();

export interface PasswordResetRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
  gate: UserGate;
  collabHooks: CollabHooks;
  limiters: { oneTimeLinkMiss: FixedWindowLimiter; oneTimeLinkAttempt: FixedWindowLimiter };
}

/** token_hash is a query param: redact DB errors so the hash doesn't reach the log. */
async function findActiveResetLink(
  db: Db,
  token: string,
  log: FastifyBaseLogger,
): Promise<{ id: string; targetUserId: string; email: string; expiresAt: Date } | null> {
  if (!isOneTimeTokenShape("password_reset", token)) return null;
  let row: { id: string; targetUserId: string | null; email: string; expiresAt: Date } | undefined;
  try {
    [row] = await db
      .select({ id: oneTimeLinks.id, targetUserId: oneTimeLinks.targetUserId, email: users.email, expiresAt: oneTimeLinks.expiresAt })
      .from(oneTimeLinks)
      .innerJoin(users, eq(users.id, oneTimeLinks.targetUserId))
      .where(and(eq(oneTimeLinks.tokenHash, hashToken(token)), activeOneTimeLink("password_reset")))
      .limit(1);
  } catch (err) {
    throw redactDbError(log, err, "查詢重設密碼連結");
  }
  if (!row || row.targetUserId === null) return null;
  return { id: row.id, targetUserId: row.targetUserId, email: row.email, expiresAt: row.expiresAt };
}

const TOO_MANY_REQUESTS_MESSAGE = "Too many requests. Wait a moment and try again.";

export function passwordResetRoutes(deps: PasswordResetRouteDeps) {
  function sendInvalidLink(reply: FastifyReply, ip: string): FastifyReply {
    if (!deps.limiters.oneTimeLinkMiss.consume(ip)) return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
    return sendError(reply, 410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/auth/password-reset/inspect", async (request, reply) => {
      const parsed = inspectBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const link = await findActiveResetLink(deps.db, parsed.data.token, request.log);
      if (!link) return sendInvalidLink(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      return reply.send({ email: link.email, expiresAt: link.expiresAt.toISOString() });
    });

    app.post("/api/auth/password-reset", async (request, reply) => {
      const parsed = completeBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const { token, newPassword } = parsed.data;
      const link = await findActiveResetLink(deps.db, token, request.log);
      if (!link) return sendInvalidLink(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      if (!deps.limiters.oneTimeLinkAttempt.consume(`link:${link.id}`)) {
        return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }
      const ttlSeconds = deps.siteLimits.get("sessionTtlSeconds");
      const input = { linkId: link.id, targetUserId: link.targetUserId, passwordHash, ttlSeconds };
      let updated: Awaited<ReturnType<typeof completePasswordResetInTx>>;
      try {
        updated = await deps.db.transaction(tx => completePasswordResetInTx(tx, input));
      } catch (err) {
        // A 410 inside the tx comes from concurrency (a valid token passed the lookup): no miss charge.
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // UPDATE params carry the password hash.
        throw redactDbError(request.log, err, "重設密碼");
      }
      deps.gate.invalidate(updated.id);
      deps.collabHooks.onUserRevoked(updated.id);
      request.log.info({ targetUserId: updated.id, linkId: link.id }, "重設密碼連結已使用");
      await touchLastLogin(deps.db, updated.id, request.log);
      await setSessionCookieFor(reply, deps.config, { userId: updated.id, tv: updated.tokenVersion, sid: updated.sessionId, ttlSeconds });
      const dto: UserDto = {
        id: updated.id,
        email: updated.email,
        handle: updated.handle,
        displayName: updated.displayName,
        isAdmin: updated.isAdmin,
        mustChangePassword: updated.mustChangePassword,
        hasPassword: true,
        autoVersions: updated.autoVersions,
        avatar: await readCurrentAvatar(deps.db, updated.id),
      };
      return reply.send(dto);
    });
  };
}
