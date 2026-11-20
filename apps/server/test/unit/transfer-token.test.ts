/**
 * `knbt_` has `t` as its 4th character, not `_`, so `isAccessTokenShape("knbt_…")` is false: a transfer token sent to an
 * `authenticateTokenOrSession` route fails the prefix check with a 401 and never reaches the DB (same trick as `knbr_`;
 * see the refresh case in `test/unit/api-token.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_PREFIX, generateAccessToken, generateRefreshToken, isAccessTokenShape } from "../../src/auth/api-token.js";
import { buildTransferChallenge } from "../../src/auth/challenge.js";
import {
  MAX_PENDING_UPLOAD_TOKENS,
  TRANSFER_TOKEN_PREFIX,
  generateTransferToken,
  isTransferTokenShape,
} from "../../src/auth/transfer-token.js";

describe("transfer token plaintext format", () => {
  it("knbt_ + 43 base64url chars (48 total), different every time", () => {
    const a = generateTransferToken();
    const b = generateTransferToken();
    expect(a).toMatch(/^knbt_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(48);
    expect(a).not.toBe(b);
  });

  it("prefix is not an extension of knb_: a transfer token is not access-token shaped (4th char t vs _)", () => {
    expect(TRANSFER_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateTransferToken())).toBe(false);
  });

  it("isTransferTokenShape only accepts a knbt_ prefix: knb_, knbr_ and knbt_ not at the start all fail", () => {
    expect(isTransferTokenShape(generateTransferToken())).toBe(true);
    expect(isTransferTokenShape(generateAccessToken())).toBe(false);
    expect(isTransferTokenShape(generateRefreshToken())).toBe(false);
    expect(isTransferTokenShape("Xknbt_abc")).toBe(false);
  });

  it("each parent credential may hold at most 5 unconsumed upload tokens", () => {
    expect(MAX_PENDING_UPLOAD_TOKENS).toBe(5);
  });
});

describe("buildTransferChallenge", () => {
  it("with error: exactly `Bearer realm=\"knotebook-transfer\", error=\"invalid_token\"`, no resource_metadata or scope", () => {
    expect(buildTransferChallenge("invalid_token")).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
  });
  it("without error (other-scheme): exactly `Bearer realm=\"knotebook-transfer\"`", () => {
    expect(buildTransferChallenge()).toBe('Bearer realm="knotebook-transfer"');
  });
});
