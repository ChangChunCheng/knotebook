import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as client from "openid-client";
import { normalizeEmail, OIDC_STATE_COOKIE, safeNextPath } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { isUniqueViolation, pgErrorSummary } from "../db/pg-errors.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { UUID_RE } from "../notes/service.js";
import { unsealOidcState } from "../auth/oidc-state.js";
import { clearOidcStateCookie, setOidcStateCookie, startAuthorization } from "../auth/oidc-authorize.js";
import { OidcUnavailableError, oidcErrorLogFields, oidcRedirectUri, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { loadEnabledProvider, loadLegacyProvider, providerConfiguration, type OidcProviderRow } from "../auth/oidc-providers.js";
import type { OidcClaims } from "../auth/oidc-login-decision.js";
import { resolveOidcLoginInTx, type ResolveOidcLoginResult } from "../auth/tx/oidc-login.js";
import { clearPendingCookie, newPendingId, OIDC_PENDING_TTL_SECONDS, readPendingLink, sealPendingLinkWithinLimit, setPendingCookie } from "../auth/oidc-pending.js";
import { linkIdentityToUserInTx, linkPendingIdentityInTx, type LinkedUser } from "../auth/tx/link-identity.js";
import { TxAbort } from "../http/tx-abort.js";
import type { OidcTestHook } from "../auth/oidc-test-hook.js";
import { resolveSessionUser, type UserGate } from "../auth/session.js";
import { startSession } from "../auth/sessions.js";
import type { CollabHooks } from "../collab/hooks.js";
import { touchLastLogin } from "../auth/last-login.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { pickPicture } from "../avatars/oidc-picture.js";
import { scheduleOidcAvatarJob, type OidcAvatarJobHooks } from "../avatars/oidc-job.js";
import type { AvatarFetchPolicy } from "../avatars/oidc-fetch.js";


/** A SQLSTATE-shaped code means a DB error whose message/params may hold sub/email: use redactDbError. */
function hasSqlState(err: unknown): boolean {
  const { code } = pgErrorSummary(err);
  return code !== null && /^[0-9A-Z]{5}$/.test(code);
}

/** Bounds the pending cookie size. */
export const MAX_EMAIL_CLAIM_LENGTH = 254;
export const MAX_SUB_CLAIM_LENGTH = 255;

export interface OidcRouteDeps {
  config: AppConfig;
  db: Db;
  siteLimits: SiteLimits;
  gate: UserGate;
  collabHooks: CollabHooks;
  reloginReverifyDelayMs?: number;
  registry: OidcRuntimeRegistry;
  /** Separate limiters for login and callback (#16); the SSO proof start uses oidcLogin. */
  limiters: { oidcLogin: FixedWindowLimiter; oidcCallback: FixedWindowLimiter };
  oidcTestHook?: OidcTestHook;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  avatarFetchPolicy?: AvatarFetchPolicy;
  avatarJobHooks?: OidcAvatarJobHooks;
}

type ProviderRef = { kind: "legacy" } | { kind: "id"; raw: string };

function nonEmptyClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// Every outcome is a 302: the caller is a top-level browser navigation, never JSON.
export function oidcRoutes(deps: OidcRouteDeps) {
  const configDeps = { db: deps.db, registry: deps.registry, appSecret: deps.config.appSecret };

  async function loadProvider(ref: ProviderRef): Promise<OidcProviderRow | null> {
    return ref.kind === "legacy" ? loadLegacyProvider(deps.db) : loadEnabledProvider(deps.db, ref.raw.toLowerCase());
  }

  async function startLogin(request: FastifyRequest, reply: FastifyReply, ref: ProviderRef): Promise<FastifyReply> {
    if (ref.kind === "id" && !UUID_RE.test(ref.raw)) return reply.redirect("/login?error=oidc_unavailable");
    if (!deps.limiters.oidcLogin.consume(request.ip)) return reply.redirect("/login?error=too_many_requests");
    try {
      const provider = await loadProvider(ref);
      if (provider === null) return reply.redirect("/login?error=oidc_unavailable");
      let configuration: client.Configuration;
      try {
        configuration = await providerConfiguration({ ...configDeps, log: request.log }, provider);
      } catch (err) {
        request.log.warn({ ...oidcErrorLogFields(err), providerId: provider.id }, "OIDC discovery 不可用，導回登入頁");
        return reply.redirect("/login?error=oidc_unavailable");
      }
      const rawNext = (request.query as Record<string, unknown>).next;
      const requestedNext = safeNextPath(typeof rawNext === "string" ? rawNext : null);
      const { sealedState, url } = await startAuthorization(deps.config, provider, configuration, {
        intent: "login",
        ...(requestedNext !== null ? { next: requestedNext } : {}),
      });
      setOidcStateCookie(reply, deps.config, sealedState);
      return reply.redirect(url.href);
    } catch (err) {
      // Keep the always-302 contract even if building the authorization URL or the DB fails.
      request.log.warn(oidcErrorLogFields(err), "OIDC login 失敗，導回登入頁");
      return reply.redirect("/login?error=oidc_unavailable");
    }
  }

  async function handleCallback(request: FastifyRequest, reply: FastifyReply, ref: ProviderRef): Promise<FastifyReply> {
    if (ref.kind === "id" && !UUID_RE.test(ref.raw)) return reply.redirect("/login?error=oidc_unavailable");
    // The state cookie is stateless, so without counting this would amplify onto the IdP token endpoint.
    if (!deps.limiters.oidcCallback.consume(request.ip)) return reply.redirect("/login?error=too_many_requests");

    let nextPath: string | null = null;
    const loginErrorLocation = (code: string): string =>
      nextPath === null ? `/login?error=${code}` : `/login?error=${code}&next=${encodeURIComponent(nextPath)}`;
    let intent: "login" | "prove" | "link" | null = null;
    const failLocation = (code: string): string =>
      intent === "prove" ? `/link-account?error=${code}` : intent === "link" ? `/settings/login?link_error=${code}` : loginErrorLocation(code);

    try {
      const provider = await loadProvider(ref);
      if (provider === null) return reply.redirect(loginErrorLocation("oidc_unavailable"));

      const sealedCookie = request.cookies[OIDC_STATE_COOKIE];
      clearOidcStateCookie(reply, deps.config);
      if (sealedCookie === undefined) return reply.redirect(loginErrorLocation("oidc_state_mismatch"));
      const payload = unsealOidcState(deps.config.appSecret, sealedCookie, Math.floor(Date.now() / 1000));
      if (payload === null) return reply.redirect(loginErrorLocation("oidc_state_mismatch"));
      intent = payload.intent;
      // A sealed cookie proves we sealed it, not that it is still safe: re-validate.
      nextPath = payload.intent === "login" && payload.next !== undefined ? safeNextPath(payload.next) : null;

      if (payload.providerId !== provider.id) return reply.redirect(failLocation("oidc_state_mismatch"));
      if (payload.configVersion !== provider.configVersion) return reply.redirect(failLocation("oidc_unavailable"));
      const query = request.query as Record<string, unknown>;
      if (typeof query.state !== "string" || query.state !== payload.state) return reply.redirect(failLocation("oidc_state_mismatch"));

      let configuration: client.Configuration;
      try {
        configuration = await providerConfiguration({ ...configDeps, log: request.log }, provider);
      } catch (err) {
        if (!(err instanceof OidcUnavailableError)) throw err;
        request.log.warn({ ...oidcErrorLogFields(err), providerId: provider.id }, "OIDC discovery 不可用，導回登入頁");
        return reply.redirect(failLocation("oidc_unavailable"));
      }

      // currentUrl derives from the single helper, not request.host (TLS-terminating proxies drift).
      const currentUrl = new URL(oidcRedirectUri(deps.config, provider));
      const rawUrl = request.raw.url ?? "";
      const queryIndex = rawUrl.indexOf("?");
      currentUrl.search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
      try {
        tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
          expectedState: payload.state,
          expectedNonce: payload.nonce,
          pkceCodeVerifier: payload.codeVerifier,
        });
      } catch (err) {
        request.log.warn(oidcErrorLogFields(err), "OIDC code 交換失敗");
        return reply.redirect(failLocation("oidc_exchange_failed"));
      }
      const idTokenClaims = tokens.claims();
      if (idTokenClaims === undefined) {
        request.log.warn("OIDC token 交換成功但缺 id_token claims");
        return reply.redirect(failLocation("oidc_exchange_failed"));
      }

      const metadata = configuration.serverMetadata();
      const sub = idTokenClaims.sub;
      let email = nonEmptyClaim(idTokenClaims.email);
      const name = typeof idTokenClaims.name === "string" ? idTokenClaims.name : null;
      let preferredUsername = nonEmptyClaim(idTokenClaims.preferred_username);
      // userinfo only when the ID token lacks email; the IdP's email_verified flag is never read.
      let userinfo: Record<string, unknown> | undefined;
      if (email === null && metadata.userinfo_endpoint !== undefined) {
        try {
          userinfo = await client.fetchUserInfo(configuration, tokens.access_token, sub);
        } catch (err) {
          request.log.warn(oidcErrorLogFields(err), "OIDC userinfo 取得失敗");
          return reply.redirect(failLocation("oidc_exchange_failed"));
        }
        email = nonEmptyClaim(userinfo.email);
        if (preferredUsername === null) preferredUsername = nonEmptyClaim(userinfo.preferred_username);
      }
      const normalizedEmail = email !== null ? normalizeEmail(email) : null;
      if ((normalizedEmail !== null && normalizedEmail.length > MAX_EMAIL_CLAIM_LENGTH) || sub.length > MAX_SUB_CLAIM_LENGTH) {
        request.log.warn({ emailLength: normalizedEmail?.length ?? 0, subLength: sub.length }, "OIDC claim 過長，拒收");
        return reply.redirect(failLocation("oidc_claim_too_long"));
      }
      // Issuer is serverMetadata().issuer (the ID token iss), not the admin-typed string.
      const claims: OidcClaims = { issuer: metadata.issuer, sub, email: normalizedEmail, name, preferredUsername };
      const picture = pickPicture(idTokenClaims, userinfo);
      const scheduleAvatar = (userId: string): void =>
        scheduleOidcAvatarJob(
          {
            db: deps.db,
            gate: deps.gate,
            uploadsDir: deps.uploadsDir,
            storageLockTimeoutMs: deps.storageLockTimeoutMs,
            avatarFetchPolicy: deps.avatarFetchPolicy,
            avatarJobHooks: deps.avatarJobHooks,
            log: request.log,
          },
          { userId, issuer: claims.issuer, sub: claims.sub, picture },
        );

      if (payload.intent === "link") {
        // Session checked inline, not via the authenticate preHandler, so this callback still answers 302 (browser navigation) instead of a 401 JSON.
        const session = await resolveSessionUser(request.cookies, deps.config.appSecret, deps.gate);
        if (session === null || session.user.id !== payload.linkUserId) return reply.redirect(failLocation("oidc_link_session_mismatch"));
        const linkInput = { userId: payload.linkUserId, issuer: claims.issuer, sub: claims.sub };
        try {
          await deps.db.transaction(tx => linkIdentityToUserInTx(tx, linkInput));
        } catch (err) {
          if (!(err instanceof TxAbort)) throw err;
          return reply.redirect(failLocation(err.errCode));
        }
        scheduleAvatar(payload.linkUserId);
        return reply.redirect(`/settings/login?linked=${provider.id}`);
      }

      if (payload.intent === "prove") {
        // The new identity comes from pending; the picture in this callback belongs to the proving identity, so no avatar is scheduled.
        const pending = readPendingLink(request, deps.config.appSecret);
        if (pending === null) {
          clearPendingCookie(reply, deps.config);
          return reply.redirect(failLocation("oidc_link_expired"));
        }
        // Mismatch = another tab overwrote pending; leave the new one alone.
        if (pending.pendingId !== payload.pendingId || pending.userId !== payload.proveUserId) {
          return reply.redirect(failLocation("oidc_link_expired"));
        }
        const proveInput = {
          targetUserId: pending.userId,
          pendingEmail: pending.email,
          issuer: pending.issuer,
          sub: pending.sub,
          proof: { kind: "sso" as const, issuer: claims.issuer, sub: claims.sub },
        };
        let linked: LinkedUser;
        try {
          linked = await deps.db.transaction(tx => linkPendingIdentityInTx(tx, proveInput, deps.oidcTestHook));
        } catch (err) {
          if (!(err instanceof TxAbort)) throw err;
          if (err.errCode === "oidc_link_expired") clearPendingCookie(reply, deps.config);
          return reply.redirect(failLocation(err.errCode));
        }
        clearPendingCookie(reply, deps.config);
        deps.gate.invalidate(linked.id);
        await touchLastLogin(deps.db, linked.id, request.log);
        await startSession(deps, request, reply, { userId: linked.id, tv: linked.tokenVersion });
        return reply.redirect((pending.next !== undefined ? safeNextPath(pending.next) : null) ?? "/");
      }

      const loginInput = { claims, providerId: provider.id, configVersion: provider.configVersion };
      const runLogin = () => deps.db.transaction(tx => resolveOidcLoginInTx(tx, loginInput, deps.oidcTestHook));
      let resolved: ResolveOidcLoginResult;
      try {
        resolved = await runLogin();
      } catch (err) {
        // One retry is enough: the other transaction has committed, so the rerun finds its row.
        if (!isUniqueViolation(err)) throw err;
        try {
          resolved = await runLogin();
        } catch (err2) {
          if (hasSqlState(err2)) redactDbError(request.log, err2, "OIDC 帳號解析 race 重查");
          else request.log.error(oidcErrorLogFields(err2), "OIDC 帳號解析 race 重查後仍失敗");
          return reply.redirect(failLocation("oidc_exchange_failed"));
        }
      }
      if (resolved.settingsMissing) request.log.error("site_settings 讀不到列：SSO 首登自動建帳視同關閉（#187）");
      if (resolved.providerStale) request.log.warn({ providerId: provider.id }, "登入進行期間服務設定已變或已刪：SSO 首登視同關閉");

      const outcome = resolved.outcome;
      if (outcome.kind === "reject") {
        if (outcome.code === "oidc_conflict") request.log.warn("OIDC 帳號衝突：lower(email) 命中多列");
        return reply.redirect(failLocation(outcome.code));
      }
      if (outcome.kind === "confirm_link") {
        const sealed = sealPendingLinkWithinLimit(deps.config.appSecret, {
          pendingId: newPendingId(),
          issuer: claims.issuer,
          sub: claims.sub,
          providerId: provider.id,
          userId: outcome.userId,
          email: outcome.email,
          exp: Math.floor(Date.now() / 1000) + OIDC_PENDING_TTL_SECONDS,
          ...(nextPath !== null ? { next: nextPath } : {}),
        });
        if (sealed === null) {
          request.log.warn("pending-link cookie 封章後仍超過上限，不封章");
          return reply.redirect(failLocation("oidc_claim_too_long"));
        }
        setPendingCookie(reply, deps.config, sealed.sealed);
        return reply.redirect("/link-account");
      }
      // Only a created user changes the cached UserDto; last_login_at isn't in it.
      if (outcome.kind === "created") deps.gate.invalidate(outcome.userId);
      await touchLastLogin(deps.db, outcome.userId, request.log);
      await startSession(deps, request, reply, { userId: outcome.userId, tv: outcome.tokenVersion });
      scheduleAvatar(outcome.userId);
      return reply.redirect(nextPath ?? "/");
    } catch (err) {
      if (hasSqlState(err)) redactDbError(request.log, err, "OIDC callback");
      else request.log.error(oidcErrorLogFields(err), "OIDC callback 發生未預期錯誤");
      return reply.redirect(failLocation("oidc_exchange_failed"));
    }
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/oidc/login", (request, reply) => startLogin(request, reply, { kind: "legacy" }));
    app.get<{ Params: { providerId: string } }>("/api/auth/oidc/login/:providerId", (request, reply) =>
      startLogin(request, reply, { kind: "id", raw: request.params.providerId }),
    );
    app.get("/api/auth/oidc/callback", (request, reply) => handleCallback(request, reply, { kind: "legacy" }));
    app.get<{ Params: { providerId: string } }>("/api/auth/oidc/callback/:providerId", (request, reply) =>
      handleCallback(request, reply, { kind: "id", raw: request.params.providerId }),
    );
  };
}
