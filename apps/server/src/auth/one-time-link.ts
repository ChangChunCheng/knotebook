import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { oneTimeLinks } from "../db/schema.js";

/** Deliberately not an extension of `knb_` (4th char `p`), so reset tokens fail `isAccessTokenShape` without a DB lookup; see `test/unit/one-time-link.test.ts`. */
export const RESET_TOKEN_PREFIX = "knbp_";

/** Same reason as the reset prefix: 4th char `i`, so `isAccessTokenShape("knbi_...")` is false. */
export const INVITE_TOKEN_PREFIX = "knbi_";

export type OneTimeLinkKind = "password_reset" | "invite";

const PREFIX: Record<OneTimeLinkKind, string> = { password_reset: RESET_TOKEN_PREFIX, invite: INVITE_TOKEN_PREFIX };

export function generateOneTimeToken(kind: OneTimeLinkKind): string {
  return PREFIX[kind] + randomBytes(32).toString("base64url");
}

export function isOneTimeTokenShape(kind: OneTimeLinkKind, token: string): boolean {
  const prefix = PREFIX[kind];
  return token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length));
}

/** The only definition of "active"; times use DB `now()` and callers AND the `token_hash`/`id` match. The password-login switch is deliberately not part of it (endpoints check it): rows recover when it is re-enabled. */
export function activeOneTimeLink(kind: OneTimeLinkKind): SQL {
  return and(
    eq(oneTimeLinks.kind, kind),
    isNull(oneTimeLinks.usedAt),
    isNull(oneTimeLinks.revokedAt),
    sql`${oneTimeLinks.expiresAt} > now()`,
  )!;
}

/** Ignores expiry: regenerate, cancel and disable must also revoke expired unused rows, which still occupy the "one per user" index slot. */
export function pendingPasswordResetsOf(targetUserId: string): SQL {
  return and(
    eq(oneTimeLinks.kind, "password_reset"),
    eq(oneTimeLinks.targetUserId, targetUserId),
    isNull(oneTimeLinks.usedAt),
    isNull(oneTimeLinks.revokedAt),
  )!;
}
