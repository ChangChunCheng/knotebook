import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MAX_REGISTER_DISPLAY_NAME_LENGTH,
  MAX_REGISTER_EMAIL_LENGTH,
  normalizeEmail,
  type AuthProviderTemplate,
  type IdentitiesDto,
  type IdentityDto,
  type UserDto,
} from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { oneTimeLinks, userIdentities, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { foreignKeyViolationConstraint, notNullViolationColumn, uniqueViolationConstraint } from "../db/pg-errors.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { hashToken } from "../auth/api-token.js";
import { activeOneTimeLink, isOneTimeTokenShape } from "../auth/one-time-link.js";
import { HashBusyError, hashPassword } from "../auth/password.js";
import type { UserGate } from "../auth/session.js";
import { setSessionCookieFor, startSession } from "../auth/sessions.js";
import { setPasswordInTx } from "../auth/tx/change-password.js";
import { touchLastLogin } from "../auth/last-login.js";
import { isStorableText, sendInvalidBody } from "../auth/admin-provider-input.js";
import {
  effectivePasswordLogin,
  isPasswordLoginAccepted,
  PASSWORD_LOGIN_DISABLED_MESSAGE,
  PASSWORD_LOGIN_SETTINGS_MISSING_LOG,
  readPasswordLoginSetting,
} from "../auth/password-login.js";
import { canUnlinkIdentity, enabledProvidersWithIssuer, usableIdentityIds } from "../auth/sign-in-methods.js";
import { readRegistrationEnabled, REGISTRATION_DISABLED_MESSAGE } from "../auth/site-settings.js";
import { IDENTITY_NOT_FOUND_MESSAGE, unlinkIdentityInTx } from "../auth/tx/identities.js";
import { registerUserInTx, type RegisteredUser } from "../auth/tx/register.js";
import { acceptInviteInTx, INVITE_INVALID_MESSAGE } from "../auth/tx/accept-invite.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";

export interface AccountRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
  gate: UserGate;
  collabHooks: CollabHooks;
  limiters: { register: FixedWindowLimiter; oneTimeLinkMiss: FixedWindowLimiter; oneTimeLinkAttempt: FixedWindowLimiter };
  reloginReverifyDelayMs?: number;
}

const TOO_MANY_REQUESTS_MESSAGE = "Too many requests. Wait a moment and try again.";

const MAX_DERIVE_ATTEMPTS = 3;

// `.refine`, not `.max`: sendInvalidBody only surfaces custom messages. 254 must equal MAX_EMAIL_CLAIM_LENGTH in routes/oidc.ts.
const emailField = z
  .string()
  .trim()
  .email()
  .refine(s => s.length <= MAX_REGISTER_EMAIL_LENGTH, `The email can be at most ${MAX_REGISTER_EMAIL_LENGTH} characters.`);
const displayNameField = z
  .string()
  .trim()
  .refine(isStorableText, "The display name contains characters that can't be stored.")
  .refine(s => s.length > 0, "The display name can't be empty.")
  .refine(s => [...s].length <= MAX_REGISTER_DISPLAY_NAME_LENGTH, `The display name can be at most ${MAX_REGISTER_DISPLAY_NAME_LENGTH} characters.`)
  .optional();

const registerBodySchema = z.object({ email: emailField, password: z.string(), displayName: displayNameField }).strict();
// strict on both bodies: no field can set is_admin / must_change_password.
const acceptInviteBodySchema = z.object({ token: z.string(), email: emailField, password: z.string(), displayName: displayNameField }).strict();
const inspectInviteBodySchema = z.object({ token: z.string() }).strict();

/** Cut by code point (a local-part can be 242 chars; slicing UTF-16 could split a surrogate pair). */
function defaultDisplayName(email: string): string {
  return Array.from(email.split("@")[0]!).slice(0, MAX_REGISTER_DISPLAY_NAME_LENGTH).join("");
}

/** Params carry token_hash, so unexpected DB errors are redacted (the hash must not reach the log). */
async function findActiveInvite(db: Db, token: string, log: FastifyBaseLogger): Promise<{ id: string; expiresAt: Date } | null> {
  if (!isOneTimeTokenShape("invite", token)) return null;
  try {
    const [row] = await db
      .select({ id: oneTimeLinks.id, expiresAt: oneTimeLinks.expiresAt })
      .from(oneTimeLinks)
      .where(and(eq(oneTimeLinks.tokenHash, hashToken(token)), activeOneTimeLink("invite")))
      .limit(1);
    return row ?? null;
  } catch (err) {
    throw redactDbError(log, err, "查詢邀請");
  }
}

/** Invites (#285) ignore "allow self-registration" and don't charge REGISTER_LIMIT: the invite is the authorization. An invalid invite is always 410 with no reason. The limiters are shared with password-reset.ts. */
export function accountRoutes(deps: AccountRouteDeps) {
  function sendInvalidInvite(reply: FastifyReply, ip: string): FastifyReply {
    if (!deps.limiters.oneTimeLinkMiss.consume(ip)) return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
    return sendError(reply, 410, "invite_invalid", INVITE_INVALID_MESSAGE);
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/auth/register", async (request, reply) => {
      if (!deps.limiters.register.consume(request.ip)) return sendError(reply, 429, "too_many_requests", "Too many sign-ups. Wait a moment and try again.");
      // Fast path; the authoritative check is the FOR SHARE read inside the transaction.
      const registrationEnabled = await readRegistrationEnabled(deps.db);
      if (registrationEnabled === null) request.log.error("site_settings 讀不到列：註冊視同關閉（#187）");
      if (registrationEnabled !== true) return sendError(reply, 403, "registration_disabled", REGISTRATION_DISABLED_MESSAGE);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const email = normalizeEmail(parsed.data.email);
      const displayName = parsed.data.displayName ?? defaultDisplayName(email);
      if (parsed.data.password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(parsed.data.password);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }

      // A derived-name collision reruns the whole tx; the 4th attempt falls back to user-<uuid8> (shared with accept-invite, `insertPasswordUserInTx`).
      let created: RegisteredUser | undefined;
      for (let attempt = 1; created === undefined && attempt <= MAX_DERIVE_ATTEMPTS + 1; attempt += 1) {
        const input = {
          id: randomUUID(),
          email,
          displayName,
          passwordHash,
          useFallbackHandle: attempt > MAX_DERIVE_ATTEMPTS,
          passwordLoginForced: deps.config.passwordLoginForceEnable,
        };
        try {
          created = await deps.db.transaction(tx => registerUserInTx(tx, input));
        } catch (err) {
          if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "users_email_unique") return sendError(reply, 409, "email_taken", "That email is already in use.");
          if ((constraint === "handles_pkey" || constraint === "users_handle_unique") && attempt <= MAX_DERIVE_ATTEMPTS) continue;
          // The INSERT carries the password hash: params must not reach the log.
          throw redactDbError(request.log, err, "註冊");
        }
      }
      if (created === undefined) throw new Error("註冊：handle 配置重試耗盡");

      await touchLastLogin(deps.db, created.id, request.log);
      await startSession(deps, request, reply, { userId: created.id, tv: created.tokenVersion });
      const dto: UserDto = {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        isAdmin: false,
        mustChangePassword: false,
        hasPassword: true,
        autoVersions: true,
        avatar: null,
      };
      return reply.code(201).send(dto);
    });

    app.post("/api/auth/invite/inspect", async (request, reply) => {
      const parsed = inspectInviteBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const invite = await findActiveInvite(deps.db, parsed.data.token, request.log);
      if (!invite) return sendInvalidInvite(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      return reply.send({ expiresAt: invite.expiresAt.toISOString() });
    });

    // Everything decidable before argon2 is decided first.
    app.post("/api/auth/invite/accept", async (request, reply) => {
      const parsed = acceptInviteBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const invite = await findActiveInvite(deps.db, parsed.data.token, request.log);
      if (!invite) return sendInvalidInvite(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      if (!deps.limiters.oneTimeLinkAttempt.consume(`link:${invite.id}`)) {
        return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
      }
      if (parsed.data.password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      const email = normalizeEmail(parsed.data.email);
      const displayName = parsed.data.displayName ?? defaultDisplayName(email);
      // Outside the tx so an expected 409 burns no argon2 and doesn't consume the invite (re-checked inside; the unique key covers races).
      const [taken] = await deps.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      if (taken !== undefined) return sendError(reply, 409, "email_taken", "That email is already in use.");
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(parsed.data.password);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }

      let created: RegisteredUser | undefined;
      for (let attempt = 1; created === undefined && attempt <= MAX_DERIVE_ATTEMPTS + 1; attempt += 1) {
        const input = {
          linkId: invite.id,
          id: randomUUID(),
          email,
          displayName,
          passwordHash,
          useFallbackHandle: attempt > MAX_DERIVE_ATTEMPTS,
        };
        try {
          created = await deps.db.transaction(tx => acceptInviteInTx(tx, input));
        } catch (err) {
          // A 410 inside the tx comes from concurrency, so it skips sendInvalidInvite (no miss charge).
          if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "users_email_unique") return sendError(reply, 409, "email_taken", "That email is already in use.");
          if ((constraint === "handles_pkey" || constraint === "users_handle_unique") && attempt <= MAX_DERIVE_ATTEMPTS) continue;
          // Default plan deleted concurrently.
          if (foreignKeyViolationConstraint(err) === "users_storage_plan_fk") return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
          // No site_settings row: the DEFAULT function returns NULL.
          if (notNullViolationColumn(err) === "storage_plan_id") {
            request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
            return sendError(reply, 500, "internal", "Internal server error.");
          }
          // The INSERT carries the password hash: params must not reach the log.
          throw redactDbError(request.log, err, "接受邀請");
        }
      }
      if (created === undefined) throw new Error("接受邀請：handle 配置重試耗盡");

      request.log.info({ linkId: invite.id, userId: created.id }, "邀請已使用");
      await touchLastLogin(deps.db, created.id, request.log);
      await startSession(deps, request, reply, { userId: created.id, tv: created.tokenVersion });
      const dto: UserDto = {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        isAdmin: false,
        mustChangePassword: false,
        hasPassword: true,
        autoVersions: true,
        avatar: null,
      };
      return reply.code(201).send(dto);
    });

    app.get("/api/auth/identities", { preHandler: app.authenticate }, async (request): Promise<IdentitiesDto> => {
      const userId = request.user!.id;
      const mine = await deps.db
        .select({ id: userIdentities.id, issuer: userIdentities.issuer, createdAt: userIdentities.createdAt, lastLoginAt: userIdentities.lastLoginAt })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .orderBy(asc(userIdentities.createdAt), asc(userIdentities.id));
      const enabled = await enabledProvidersWithIssuer(deps.db);
      // Direct read, not the gate's 60 s cache, to match the read inside the DELETE transaction.
      const [me] = await deps.db.select({ hasPassword: sql<boolean>`${users.passwordHash} is not null` }).from(users).where(eq(users.id, userId));
      const dbValue = await readPasswordLoginSetting(deps.db);
      if (dbValue === null) request.log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
      const usable = usableIdentityIds(mine, enabled);
      const hasPassword = me?.hasPassword ?? false;
      const identities: IdentityDto[] = mine.map(i => ({
        id: i.id,
        issuer: i.issuer,
        providers: enabled.filter(p => p.effectiveIssuer === i.issuer).map(p => ({ id: p.id, displayName: p.displayName, icon: p.icon })),
        createdAt: i.createdAt.toISOString(),
        lastLoginAt: i.lastLoginAt?.toISOString() ?? null,
        unlinkable: canUnlinkIdentity(i.id, { hasPassword, passwordLoginDbValue: dbValue ?? true, usableIdentityIds: usable }),
      }));
      const linkedIssuers = new Set(mine.map(i => i.issuer));
      return {
        identities,
        linkable: enabled
          .filter(p => !linkedIssuers.has(p.effectiveIssuer))
          .map(p => ({ providerId: p.id, displayName: p.displayName, template: p.template as AuthProviderTemplate, icon: p.icon })),
        hasPassword,
        passwordLoginEnabled: effectivePasswordLogin(dbValue, deps.config.passwordLoginForceEnable),
      };
    });

    app.delete("/api/auth/identities/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const raw = (request.params as { id: string }).id;
      if (!UUID_RE.test(raw)) return sendError(reply, 404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);
      const input = { userId: request.user!.id, identityId: raw.toLowerCase() };
      let result: { settingsMissing: boolean };
      try {
        result = await deps.db.transaction(tx => unlinkIdentityInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      if (result.settingsMissing) request.log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
      return reply.code(204).send();
    });

    // No recent-login requirement (documented known limitation).
    app.post("/api/auth/password/set", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = z.object({ newPassword: z.string() }).strict().safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      // Plain unlocked read: a disable landing after it still leaves the password set; the login endpoint just won't accept it.
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const { newPassword } = parsed.data;
      if (newPassword.length < MIN_PASSWORD_LENGTH) return sendError(reply, 400, "password_too_short", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }
      const userId = request.user!.id;
      // token_version is bumped in SQL and the session rows are swapped in the same transaction, as in change-password (#388); the TTL is read once so the row and the re-signed cookie agree (#397).
      const ttlSeconds = deps.siteLimits.get("sessionTtlSeconds");
      const input = { userId, passwordHash, ttlSeconds };
      const updated = await deps.db.transaction(tx => setPasswordInTx(tx, input));
      if (updated === null) return sendError(reply, 409, "password_already_set", "This account already has a password. Change it instead.");
      deps.gate.invalidate(userId);
      deps.collabHooks.onUserRevoked(userId);
      await setSessionCookieFor(reply, deps.config, { userId, tv: updated.tokenVersion, sid: updated.sessionId, ttlSeconds });
      return reply.code(204).send();
    });
  };
}
