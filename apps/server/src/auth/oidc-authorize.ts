import type { FastifyReply } from "fastify";
import * as client from "openid-client";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import { oidcRedirectUri } from "./oidc-client.js";
import type { OidcProviderRow } from "./oidc-providers.js";
import { OIDC_STATE_COOKIE_PATH, OIDC_STATE_TTL_SECONDS, sealOidcState, type OidcStateIntent } from "./oidc-state.js";

/** Shared by login, SSO proof start and manual link. The scope must stay "openid email profile" (else the email/name claims are missing). Throws when the metadata lacks an endpoint: callers must catch. */
export async function startAuthorization(
  config: Pick<AppConfig, "appSecret" | "publicUrl">,
  provider: Pick<OidcProviderRow, "id" | "legacyCallback" | "configVersion">,
  configuration: client.Configuration,
  intent: OidcStateIntent,
): Promise<{ sealedState: string; url: URL }> {
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const sealedState = sealOidcState(config.appSecret, {
    state, nonce, codeVerifier,
    exp: Math.floor(Date.now() / 1000) + OIDC_STATE_TTL_SECONDS,
    providerId: provider.id,
    configVersion: provider.configVersion,
    ...intent,
  });
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: oidcRedirectUri(config, provider),
    scope: "openid email profile",
    state, nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { sealedState, url };
}

export function setOidcStateCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">, sealed: string): void {
  reply.setCookie(OIDC_STATE_COOKIE, sealed, {
    httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: OIDC_STATE_COOKIE_PATH, maxAge: OIDC_STATE_TTL_SECONDS,
  });
}

/** Needs the same path/sameSite/secure as `setCookie`, or the browser doesn't treat it as the same cookie. */
export function clearOidcStateCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">): void {
  reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_STATE_COOKIE_PATH, sameSite: "lax", secure: config.cookieSecure });
}
