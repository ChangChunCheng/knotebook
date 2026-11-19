import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CustomFetch } from "openid-client";

/**
 * In-process mock IdP: no real socket; returns an `openid-client` `CustomFetch` that dispatches discovery/token/userinfo/jwks responses by URL.
 * `authorize()` is the only source of nonce/state/code (it simulates the browser's top-level navigation to the authorize endpoint - the server never fetches that URL).
 */

export interface FakeIdpClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** #122: first-choice handle candidate, emitted in both id_token and userinfo (the latter for tests where userinfo is called anyway and read opportunistically; without an emit point that shape can't be built). */
  preferred_username?: string;
  /** Avatar URL, emitted in both; `omitFromIdToken(["picture"])` drops it from the id_token to build the "userinfo only" shape. */
  picture?: string;
}

// #131: adding "authorization_endpoint" builds the shape "discovery succeeds but buildAuthorizationUrl throws" - the path this harness can build that reaches the login
// handler's 4th exit (the outer catch, which also wraps randomState/PKCE/sealOidcState). A missing jwks_uri is stopped earlier in getConfiguration as
// OidcUnavailableError (a different branch); a missing userinfo_endpoint doesn't affect either.
// #187: omitting `token_endpoint_auth_methods_supported` builds the "client_secret_post not declared" shape (test-connection warning).
export type FakeIdpOmittableMetadataKey = "userinfo_endpoint" | "jwks_uri" | "authorization_endpoint" | "token_endpoint_auth_methods_supported";
export type FakeIdpOmittableIdTokenKey = "email" | "email_verified" | "nonce" | "preferred_username" | "picture";
export type FakeIdpFailTarget = "token" | "userinfo" | "discovery";

export interface FakeIdp {
  fetch: CustomFetch;
  /** Presets the identity the next `authorize()` signs; it is consumed there and must be set again, so each test flow sets it explicitly and no residue can leak into another flow. */
  setNextLogin(claims: FakeIdpClaims): void;
  authorize(location: string): { code: string; state: string };
  failNext(target: FakeIdpFailTarget): void;
  omitFromMetadata(keys: FakeIdpOmittableMetadataKey[]): void;
  omitFromIdToken(keys: FakeIdpOmittableIdTokenKey[]): void;
  /**
   * Overrides the next `/userinfo` response so ID token and userinfo claims can deliberately differ (for the "ID token value wins" merge test); layered over the claims
   * from `setNextLogin` (replaces only the named fields), one-shot, restored when consumed (like `failNext`, no leftover state).
   */
  overrideNextUserinfo(claims: Partial<FakeIdpClaims>): void;
  counts: { discovery: number; token: number; userinfo: number };
}

interface AuthorizedCode {
  claims: FakeIdpClaims;
  nonce: string;
  codeChallenge: string;
  redirectUri: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyToParams(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  return new URLSearchParams();
}

export function createFakeIdp(issuerUrl: string): FakeIdp {
  // RS256 key pair generated at startup (awaited lazily: `createFakeIdp` returns synchronously and only the jwks/token endpoint fetch handlers need it, at which point they await this shared promise).
  const keyPairPromise = generateKeyPair("RS256");
  const kid = randomUUID();

  let nextLogin: FakeIdpClaims | undefined;
  const authorizedCodes = new Map<string, AuthorizedCode>();
  // `code` is consumed and deleted on use, while the userinfo endpoint receives an access_token (not a code), so claims must be stored a second time keyed by access_token;
  // otherwise the userinfo handler has no way to get the identity.
  const accessTokenClaims = new Map<string, FakeIdpClaims>();

  let failTarget: FakeIdpFailTarget | undefined;
  let omittedMetadataKeys = new Set<FakeIdpOmittableMetadataKey>();
  let omittedIdTokenKeys = new Set<FakeIdpOmittableIdTokenKey>();
  let userinfoOverride: Partial<FakeIdpClaims> | undefined;

  const counts = { discovery: 0, token: 0, userinfo: 0 };

  function consumeFailNext(target: FakeIdpFailTarget): boolean {
    if (failTarget !== target) return false;
    failTarget = undefined;
    return true;
  }

  function setNextLogin(claims: FakeIdpClaims): void {
    nextLogin = claims;
  }

  function authorize(location: string): { code: string; state: string } {
    if (!nextLogin) {
      throw new Error("fakeIdp.authorize() 呼叫前必須先 setNextLogin() 預置身分");
    }
    const url = new URL(location);
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const codeChallenge = url.searchParams.get("code_challenge");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!state || !nonce || !codeChallenge) {
      throw new Error(`fakeIdp.authorize()：location 缺少必要參數（state/nonce/code_challenge）：${location}`);
    }

    const code = randomBytes(16).toString("hex");
    authorizedCodes.set(code, { claims: nextLogin, nonce, codeChallenge, redirectUri });
    nextLogin = undefined;

    return { code, state };
  }

  function failNext(target: FakeIdpFailTarget): void {
    failTarget = target;
  }

  function omitFromMetadata(keys: FakeIdpOmittableMetadataKey[]): void {
    omittedMetadataKeys = new Set(keys);
  }

  function omitFromIdToken(keys: FakeIdpOmittableIdTokenKey[]): void {
    omittedIdTokenKeys = new Set(keys);
  }

  function overrideNextUserinfo(claims: Partial<FakeIdpClaims>): void {
    userinfoOverride = claims;
  }

  const fetchImpl: CustomFetch = async (url, options) => {
    const path = new URL(url).pathname;

    if (path.endsWith("/.well-known/openid-configuration")) {
      counts.discovery += 1;
      if (consumeFailNext("discovery")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const metadata: Record<string, unknown> = {
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        userinfo_endpoint: `${issuerUrl}/userinfo`,
        jwks_uri: `${issuerUrl}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      };
      for (const key of omittedMetadataKeys) delete metadata[key];
      return jsonResponse(metadata);
    }

    if (path.endsWith("/token")) {
      counts.token += 1;
      if (consumeFailNext("token")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const params = bodyToParams(options.body);
      const code = params.get("code");
      const clientId = params.get("client_id");
      const record = code ? authorizedCodes.get(code) : undefined;
      if (!code || !record) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      authorizedCodes.delete(code);

      // redirect_uri binding: the redirect_uri sent in the token request must equal, character for character, the one authorize() recorded (the one in the login 302's authorize URL) -
      // standard IdP behaviour (RFC 6749 section 4.1.3). If the callback built currentUrl from `request.host`/`request.protocol` instead of `oidcRedirectUri(config)`, it shows here:
      // openid-client would re-derive a redirect_uri different from the one login sent, and the exchange must fail rather than pass silently.
      const redirectUri = params.get("redirect_uri");
      if (redirectUri !== record.redirectUri) {
        return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      }

      // PKCE binding: the hash of code_verifier must equal the code_challenge (S256) recorded by authorize() - a callback that omits or mis-passes `pkceCodeVerifier`
      // (e.g. forgets the unsealed state payload) shows up here.
      const codeVerifier = params.get("code_verifier");
      const expectedChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
      if (expectedChallenge !== record.codeChallenge) {
        return jsonResponse({ error: "invalid_grant", error_description: "PKCE code_verifier mismatch" }, 400);
      }

      const { privateKey } = await keyPairPromise;
      const idTokenClaims: Record<string, unknown> = { sub: record.claims.sub };
      if (record.claims.email !== undefined && !omittedIdTokenKeys.has("email")) {
        idTokenClaims.email = record.claims.email;
      }
      if (record.claims.email_verified !== undefined && !omittedIdTokenKeys.has("email_verified")) {
        idTokenClaims.email_verified = record.claims.email_verified;
      }
      if (record.claims.name !== undefined) {
        idTokenClaims.name = record.claims.name;
      }
      if (record.claims.preferred_username !== undefined && !omittedIdTokenKeys.has("preferred_username")) {
        idTokenClaims.preferred_username = record.claims.preferred_username;
      }
      if (record.claims.picture !== undefined && !omittedIdTokenKeys.has("picture")) {
        idTokenClaims.picture = record.claims.picture;
      }
      if (!omittedIdTokenKeys.has("nonce")) {
        idTokenClaims.nonce = record.nonce;
      }

      const idToken = await new SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuerUrl)
        .setAudience(clientId ?? "")
        // oauth4webapi requires `iat` in the id_token (`JWT "iat" claim missing`); `setExpirationTime` doesn't add `iat`.
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      const accessToken = randomBytes(16).toString("hex");
      accessTokenClaims.set(accessToken, record.claims);

      return jsonResponse({
        access_token: accessToken,
        token_type: "Bearer",
        id_token: idToken,
        scope: "openid email profile",
      });
    }

    if (path.endsWith("/userinfo")) {
      counts.userinfo += 1;
      if (consumeFailNext("userinfo")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      // `processUserInfoResponse` checks that `sub` is a string and compares it with `expectedSubject`, so an empty object always fails; look up the preset identity by Bearer token.
      const authHeader = options.headers.authorization ?? options.headers.Authorization;
      const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      const claims = accessToken ? accessTokenClaims.get(accessToken) : undefined;
      if (!claims) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      const effective: FakeIdpClaims = userinfoOverride ? { ...claims, ...userinfoOverride } : claims;
      userinfoOverride = undefined;
      const body: Record<string, unknown> = { sub: effective.sub };
      if (effective.email !== undefined) body.email = effective.email;
      if (effective.email_verified !== undefined) body.email_verified = effective.email_verified;
      if (effective.name !== undefined) body.name = effective.name;
      if (effective.preferred_username !== undefined) body.preferred_username = effective.preferred_username;
      if (effective.picture !== undefined) body.picture = effective.picture;
      return jsonResponse(body);
    }

    if (path.endsWith("/jwks")) {
      const { publicKey } = await keyPairPromise;
      const jwk = await exportJWK(publicKey);
      return jsonResponse({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  return { fetch: fetchImpl, setNextLogin, authorize, failNext, omitFromMetadata, omitFromIdToken, overrideNextUserinfo, counts };
}
