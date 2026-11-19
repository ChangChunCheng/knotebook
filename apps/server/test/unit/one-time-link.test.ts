/**
 * #286: the plaintext format of one-time links and the active predicate. Pure functions, no DB.
 *
 * `knbp_` has `p` as its 4th character, not `_`, so `isAccessTokenShape("knbp_...")` is false (same as `knbr_`/`knbt_`);
 * the active predicate is only assembled in `auth/one-time-link.ts`, and here `PgDialect` pins the SQL it produces.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { ACCESS_TOKEN_PREFIX, generateAccessToken, generateRefreshToken, isAccessTokenShape } from "../../src/auth/api-token.js";
import { generateTransferToken } from "../../src/auth/transfer-token.js";
import {
  INVITE_TOKEN_PREFIX,
  RESET_TOKEN_PREFIX,
  activeOneTimeLink,
  generateOneTimeToken,
  isOneTimeTokenShape,
  pendingPasswordResetsOf,
} from "../../src/auth/one-time-link.js";

const dialect = new PgDialect();

describe("one-time link token plaintext format", () => {
  it("knbp_ + 43 base64url characters (48 total), different every time", () => {
    const a = generateOneTimeToken("password_reset");
    const b = generateOneTimeToken("password_reset");
    expect(a).toMatch(/^knbp_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(48);
    expect(a).not.toBe(b);
  });

  it("the prefix isn't an extension of knb_: a reset token isn't an access-token shape (4th character p vs _)", () => {
    expect(RESET_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateOneTimeToken("password_reset"))).toBe(false);
  });

  it("isOneTimeTokenShape accepts exactly 43 base64url characters after knbp_", () => {
    const ok = generateOneTimeToken("password_reset");
    expect(isOneTimeTokenShape("password_reset", ok)).toBe(true);
    const bad: Array<[string, string]> = [
      ["access token", generateAccessToken()],
      ["refresh token", generateRefreshToken()],
      ["transfer token", generateTransferToken()],
      ["42 字", "knbp_" + "a".repeat(42)],
      ["44 字", "knbp_" + "a".repeat(44)],
      ["非 base64url 字元", "knbp_" + "!".repeat(43)],
      ["前多空白", " " + ok],
      ["後多空白", ok + " "],
      ["大寫前綴", "KNBP_" + "a".repeat(43)],
      ["空字串", ""],
    ];
    for (const [label, token] of bad) expect(isOneTimeTokenShape("password_reset", token), label).toBe(false);
  });

  it("an invite token is knbi_ + 43 base64url characters (48 total), different every time, and not an access-token shape", () => {
    const a = generateOneTimeToken("invite");
    const b = generateOneTimeToken("invite");
    expect(a).toMatch(/^knbi_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(48);
    expect(a).not.toBe(b);
    expect(INVITE_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(a)).toBe(false);
  });

  it("kind isolation: isOneTimeTokenShape accepts only its own prefix per kind", () => {
    const invite = generateOneTimeToken("invite");
    const reset = generateOneTimeToken("password_reset");
    expect(isOneTimeTokenShape("invite", invite)).toBe(true);
    expect(isOneTimeTokenShape("password_reset", invite)).toBe(false);
    expect(isOneTimeTokenShape("invite", reset)).toBe(false);
    expect(isOneTimeTokenShape("invite", "knbi_" + "a".repeat(42))).toBe(false);
    expect(isOneTimeTokenShape("invite", "knbi_" + "a".repeat(44))).toBe(false);
    expect(isOneTimeTokenShape("invite", "KNBI_" + "a".repeat(43))).toBe(false);
  });
});

describe("SQL predicates of one-time links", () => {
  it("activeOneTimeLink = kind matches, unused, not revoked, expires_at > now(); kind goes through a parameter", () => {
    const q = dialect.sqlToQuery(activeOneTimeLink("password_reset"));
    expect(q.sql).toBe(
      `("one_time_links"."kind" = $1 and "one_time_links"."used_at" is null and "one_time_links"."revoked_at" is null and "one_time_links"."expires_at" > now())`,
    );
    expect(q.params).toEqual(["password_reset"]);
  });

  it("activeOneTimeLink('invite'): kind goes through a parameter, the other conditions are the same", () => {
    const q = dialect.sqlToQuery(activeOneTimeLink("invite"));
    expect(q.params).toEqual(["invite"]);
    expect(q.sql).toContain(`"one_time_links"."used_at" is null`);
    expect(q.sql).toContain(`"one_time_links"."revoked_at" is null`);
    expect(q.sql).toContain(`"one_time_links"."expires_at" > now()`);
  });

  it("pendingPasswordResetsOf = kind, target, unused, not revoked, without an expiry condition", () => {
    const id = randomUUID();
    const q = dialect.sqlToQuery(pendingPasswordResetsOf(id));
    expect(q.sql).toBe(
      `("one_time_links"."kind" = $1 and "one_time_links"."target_user_id" = $2 and "one_time_links"."used_at" is null and "one_time_links"."revoked_at" is null)`,
    );
    expect(q.params).toEqual(["password_reset", id]);
  });
});
