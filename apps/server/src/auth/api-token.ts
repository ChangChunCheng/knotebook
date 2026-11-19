import { createHash, randomBytes } from "node:crypto";

/** The prefix lets the Bearer path reject foreign tokens without a DB lookup, and secret scanners match on it. The refresh prefix is deliberately not an extension of the access one (4th char `r`, not `_`) so `isAccessTokenShape` is false for it; see `test/unit/api-token.test.ts`. */
export const ACCESS_TOKEN_PREFIX = "knb_";
export const REFRESH_TOKEN_PREFIX = "knbr_";

export function generateAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function generateRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Plain sha256 on purpose: argon2/salt defend low-entropy passwords and would add tens of ms to every Bearer request. */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Three states because RFC 6750 §3 wants different challenges: an unsupported scheme (`Basic`) SHOULD NOT carry an error, an
 * invalid token gets `invalid_token`. `other-scheme` (anything that isn't a well-formed `Bearer <token>`: `Basic`, empty,
 * scheme only, whitespace inside the token; don't loosen `\S+`) still counts toward the invalid-Bearer limiter, only its
 * challenge has no error. `bearer` tokens are trimmed, non-empty and whitespace-free. `none` means the caller falls back to the cookie session.
 */
export type BearerHeader = { kind: "none" } | { kind: "other-scheme" } | { kind: "bearer"; token: string };

export function parseAuthorizationHeader(raw: string | undefined): BearerHeader {
  if (raw === undefined) return { kind: "none" };
  const match = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  if (match === null) return { kind: "other-scheme" };
  return { kind: "bearer", token: match[1]! };
}

export function isAccessTokenShape(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}
