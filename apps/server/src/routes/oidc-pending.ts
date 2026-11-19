import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { normalizeEmail, safeNextPath, type OidcRedirectDto, type PendingLinkConfirmDto, type PendingLinkDto, type UserDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { authProviders, users } from "../db/schema.js";
import { sendError, sendLoginThrottled } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { DUMMY_HASH, HashBusyError, verifyPassword } from "../auth/password.js";
import type { LoginThrottle } from "../auth/rate-limit.js";
import type { UserGate } from "../auth/session.js";
import { readCurrentAvatar } from "../avatars/read.js";
import { startSession } from "../auth/sessions.js";
import type { CollabHooks } from "../collab/hooks.js";
import { touchLastLogin } from "../auth/last-login.js";
import { oidcErrorLogFields, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { linkedEnabledProvidersWithIssuer, loadEnabledProvider, providerConfiguration } from "../auth/oidc-providers.js";
import { setOidcStateCookie, startAuthorization } from "../auth/oidc-authorize.js";
import { UUID_RE } from "../notes/service.js";
import { excludeSameIssuerProviders } from "../auth/issuer.js";
import { clearPendingCookie, readPendingLink } from "../auth/oidc-pending.js";
import type { OidcTestHook } from "../auth/oidc-test-hook.js";
import { LINK_EXPIRED_MESSAGE, linkPendingIdentityInTx, type LinkedUser } from "../auth/tx/link-identity.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

const NO_PENDING_MESSAGE = "There's no pending sign-in to link. Sign in again.";
const NO_PROOF_MESSAGE = "An account with this email already exists, but there's no way to prove it's yours: it has no password and no other sign-in service usable here. Contact the site admin.";

const confirmBodySchema = z.object({ password: z.string(), pendingId: z.string() }).strict();
const proveBodySchema = z.object({ pendingId: z.string() }).strict();

export interface OidcPendingRouteDeps {
  config: AppConfig;
  db: Db;
  siteLimits: SiteLimits;
  gate: UserGate;
  collabHooks: CollabHooks;
  reloginReverifyDelayMs?: number;
  throttle: LoginThrottle;
  registry: OidcRuntimeRegistry;
  limiters: { oidcLogin: FixedWindowLimiter };
  oidcTestHook?: OidcTestHook;
}

function toUserDto(u: LinkedUser, avatar: UserDto["avatar"]): UserDto {
  return { id: u.id, email: u.email, handle: u.handle, displayName: u.displayName, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword, hasPassword: u.hasPassword, autoVersions: u.autoVersions, avatar };
}

// Only the pending-link cookie counts, not the current session; completing in a browser signed in as someone else replaces that session.
// confirm mirrors login: verify the password first, then check disabled; disabled and "one sub per issuer" are decided only under the lock.
export function oidcPendingRoutes(deps: OidcPendingRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    async function loadTarget(userId: string): Promise<{ passwordHash: string | null; emailLower: string } | null> {
      const [row] = await deps.db
        .select({ passwordHash: users.passwordHash, emailLower: sql<string>`lower(${users.email})` })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ?? null;
    }

    app.get("/api/auth/oidc/pending", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const target = await loadTarget(pending.userId);
      if (target === null || target.emailLower !== pending.email) {
        clearPendingCookie(reply, deps.config);
        return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      }
      // Recomputed every time (a provider may have just been disabled). Same excludeSameIssuerProviders as the callback decision, else the page would reveal before proof
      // that this account already linked this IdP.
      const providers = excludeSameIssuerProviders(await linkedEnabledProvidersWithIssuer(deps.db, pending.userId), pending.issuer);
      const methods = { password: target.passwordHash !== null, providers };
      if (!methods.password && providers.length === 0) return sendError(reply, 409, "oidc_link_no_proof_method", NO_PROOF_MESSAGE);
      const [provider] = await deps.db.select({ displayName: authProviders.displayName }).from(authProviders).where(eq(authProviders.id, pending.providerId)).limit(1);
      const dto: PendingLinkDto = { pendingId: pending.pendingId, email: pending.email, providerDisplayName: provider?.displayName ?? null, methods };
      return reply.send(dto);
    });

    app.post("/api/auth/oidc/pending/confirm", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const parsed = confirmBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      if (parsed.data.pendingId !== pending.pendingId) return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      // Single funnel, shared with /api/auth/login's account and IP tracks.
      const throttleKey = normalizeEmail(pending.email);
      const allowed = deps.throttle.checkAllowed(throttleKey, request.ip);
      if (!allowed.allowed) return sendLoginThrottled(reply, allowed.retryAfterMs!);
      const target = await loadTarget(pending.userId);
      if (target === null || target.emailLower !== pending.email) {
        clearPendingCookie(reply, deps.config);
        return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      }
      let verified: boolean;
      try {
        if (target.passwordHash !== null) {
          verified = await verifyPassword(target.passwordHash, parsed.data.password);
        } else {
          await verifyPassword(DUMMY_HASH, parsed.data.password);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }
      if (!verified) {
        deps.throttle.recordFailure(throttleKey, request.ip);
        return sendError(reply, 401, "invalid_credentials", "Wrong email or password.");
      }
      await deps.oidcTestHook?.("pending-confirm-verified", { userId: pending.userId });

      const linkInput = {
        targetUserId: pending.userId,
        pendingEmail: pending.email,
        issuer: pending.issuer,
        sub: pending.sub,
        proof: { kind: "password" as const, passwordHash: target.passwordHash! },
      };
      let linked: LinkedUser;
      try {
        linked = await deps.db.transaction(tx => linkPendingIdentityInTx(tx, linkInput, deps.oidcTestHook));
      } catch (err) {
        if (!(err instanceof TxAbort)) throw err;
        if (err.errCode === "oidc_link_expired") clearPendingCookie(reply, deps.config);
        // Only a successful transaction records success; in-tx rejections record neither success nor failure.
        return sendError(reply, err.status, err.errCode, err.message);
      }
      deps.throttle.recordSuccess(throttleKey, request.ip);
      clearPendingCookie(reply, deps.config);
      deps.gate.invalidate(linked.id);
      await touchLastLogin(deps.db, linked.id, request.log);
      await startSession(deps, request, reply, { userId: linked.id, tv: linked.tokenVersion });
      const next = (pending.next !== undefined ? safeNextPath(pending.next) : null) ?? "/";
      const body: PendingLinkConfirmDto = { user: toUserDto(linked, await readCurrentAvatar(deps.db, linked.id)), next };
      return reply.send(body);
    });

    // Requires a JSON body so cross-site forms can't hit it (CSRF hook).
    app.post<{ Params: { providerId: string } }>("/api/auth/oidc/pending/prove/:providerId", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const parsed = proveBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      if (parsed.data.pendingId !== pending.pendingId) return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      if (!deps.limiters.oidcLogin.consume(request.ip)) return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      const raw = request.params.providerId;
      const providerId = UUID_RE.test(raw) ? raw.toLowerCase() : null;
      const usable = excludeSameIssuerProviders(await linkedEnabledProvidersWithIssuer(deps.db, pending.userId), pending.issuer);
      const provider = providerId !== null && usable.some(p => p.id === providerId) ? await loadEnabledProvider(deps.db, providerId) : null;
      if (provider === null) return sendError(reply, 404, "provider_not_found", "No enabled sign-in service with that id.");
      let url: URL;
      try {
        const configuration = await providerConfiguration({ db: deps.db, registry: deps.registry, appSecret: deps.config.appSecret, log: request.log }, provider);
        const started = await startAuthorization(deps.config, provider, configuration, { intent: "prove", pendingId: pending.pendingId, proveUserId: pending.userId });
        setOidcStateCookie(reply, deps.config, started.sealedState);
        url = started.url;
      } catch (err) {
        request.log.warn({ ...oidcErrorLogFields(err), providerId: provider.id }, "SSO 證明起點：discovery 不可用");
        return sendError(reply, 503, "oidc_unavailable", "The sign-in service is unavailable right now. Try again later.");
      }
      const body: OidcRedirectDto = { url: url.href };
      return reply.send(body);
    });

    // No body: a cross-site trigger only costs the user another SSO click.
    app.post("/api/auth/oidc/pending/cancel", async (_request, reply) => {
      clearPendingCookie(reply, deps.config);
      return reply.code(204).send();
    });
  };
}
