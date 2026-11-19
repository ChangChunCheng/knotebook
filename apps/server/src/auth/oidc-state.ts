import { sealCookieJson, unsealCookieJson } from "./sealed-cookie.js";

// The payload is bound to the issuing provider (`providerId`), its `configVersion` and an `intent`; a cookie missing
// any of the three was sealed before the deploy and unseals to null (the in-flight login fails once).

export interface OidcStateBase {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Checked server-side; the cookie `maxAge` is only a browser hint. */
  exp: number;
  providerId: string;
  configVersion: number;
}

export type OidcStateIntent = {
  intent: "login";
      /** Re-validated by the callback after unsealing: the seal proves we issued it, not that it is still safe (the criterion may have tightened while an old cookie was in flight). No second length cap: `safeNextPath` (`MAX_NEXT_PATH_LENGTH` = 2048) is the only gate; a 2048-char `next` seals to about 3165 bytes of `name=value`, under the 4 KB cookie limit, so a smaller cap only dropped valid paths. */
  next?: string;
} | {
  intent: "prove";
  pendingId: string;
  proveUserId: string;
} | {
  intent: "link";
  linkUserId: string;
};

export type OidcStatePayload = OidcStateBase & OidcStateIntent;

export const OIDC_STATE_TTL_SECONDS = 600;

export const OIDC_STATE_COOKIE_PATH = "/api/auth/oidc";

export function sealOidcState(appSecret: string, payload: OidcStatePayload): string {
  return sealCookieJson(appSecret, "oidc-state", payload);
}

/** Replay after consumption is not handled here: one-time use comes from the callback's clearCookie, the short `exp` and the single-use authorization code. */
export function unsealOidcState(appSecret: string, sealed: string, nowEpochSeconds: number): OidcStatePayload | null {
  const parsed = unsealCookieJson(appSecret, "oidc-state", sealed);
  if (parsed === null) return null;

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).state !== "string" ||
    typeof (parsed as Record<string, unknown>).nonce !== "string" ||
    typeof (parsed as Record<string, unknown>).codeVerifier !== "string" ||
    typeof (parsed as Record<string, unknown>).exp !== "number"
  ) {
    return null;
  }

  const p = parsed as Record<string, unknown>;
  if (typeof p.providerId !== "string" || !Number.isInteger(p.configVersion)) return null;
  if (p.intent === "prove") {
    if (typeof p.pendingId !== "string" || typeof p.proveUserId !== "string") return null;
    const { next, ...rest } = p;
    void next;
    return (rest.exp as number) <= nowEpochSeconds ? null : (rest as unknown as OidcStatePayload);
  }
  if (p.intent === "link") {
    if (typeof p.linkUserId !== "string") return null;
    const { next, ...rest } = p;
    void next;
    return (rest.exp as number) <= nowEpochSeconds ? null : (rest as unknown as OidcStatePayload);
  }
  if (p.intent !== "login") return null;

  // `next` is optional, but present-and-not-a-string (including null) is a bad payload. Don't simplify to
  // `if (nextValue && typeof ...)`: null would slip through (an empty string is valid).
  const nextValue = (parsed as Record<string, unknown>).next;
  if (nextValue !== undefined && typeof nextValue !== "string") {
    return null;
  }

  const payload = parsed as OidcStatePayload;
  if (payload.exp <= nowEpochSeconds) return null;
  return payload;
}
