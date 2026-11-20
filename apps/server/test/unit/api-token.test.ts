/**
 * #130: plaintext API token format (`auth/api-token.ts`) and `WWW-Authenticate` construction (`auth/challenge.ts`).
 *
 * `knbr_` is not an extension of `knb_`, so a refresh token sent as a Bearer fails the prefix check with a 401 and never reaches the DB
 * lookup; that holds only because the characters differ. The Authorization header is parsed into three states because RFC 6750 wants
 * different challenge shapes for a non-Bearer scheme and for a Bearer with a bad token.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  isAccessTokenShape,
  parseAuthorizationHeader,
} from "../../src/auth/api-token.js";
import { buildBearerChallenge } from "../../src/auth/challenge.js";

describe("token plaintext format", () => {
  it("access token is knb_ + 43 base64url chars (47 total), different every time", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(47);
    expect(a).not.toBe(b);
  });

  it("refresh token is knbr_ + 43 chars (48 total)", () => {
    expect(generateRefreshToken()).toMatch(/^knbr_[A-Za-z0-9_-]{43}$/);
    expect(generateRefreshToken()).toHaveLength(48);
  });

  it("refresh token is not a valid access-token shape (4th char r vs _)", () => {
    // This relies on neither prefix being a prefix of the other; check here before changing a prefix. A refresh token sent as a
    // Bearer must get the prefix-mismatch 401 rather than reach the DB lookup.
    expect(REFRESH_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateRefreshToken())).toBe(false);
    expect(isAccessTokenShape(generateAccessToken())).toBe(true);
  });

  it("prefix must be at the start, not merely contained: Xknb_... is not an access-token shape", () => {
    // The previous test only feeds generateRefreshToken(), and "knb_" appearing after knbr_ is roughly a 2x10^-6 chance, so it would
    // stay green if startsWith became includes. The prefix gate exists so garbage gets a 401 without a DB lookup; loosening it to
    // includes would make every garbage input do an access_token_hash index lookup.
    expect(isAccessTokenShape("Xknb_abc")).toBe(false);
  });

  it("hashToken is sha256 hex, deterministic, and different inputs give different outputs", () => {
    expect(hashToken("knb_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("knb_x")).toBe(hashToken("knb_x"));
    expect(hashToken("knb_x")).not.toBe(hashToken("knb_y"));
  });

  it("hashToken is real sha256, not a home-grown hash", () => {
    // Compare against a known Node value: fails if the implementation switches digest or adds a salt.
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseAuthorizationHeader", () => {
  it("no header -> none (caller falls back to the cookie session)", () => {
    expect(parseAuthorizationHeader(undefined)).toEqual({ kind: "none" });
  });

  it("Bearer (scheme is case-insensitive) -> token extracted", () => {
    expect(parseAuthorizationHeader("Bearer knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("bearer knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("BEARER knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("  Bearer   knb_abc  ")).toEqual({ kind: "bearer", token: "knb_abc" });
  });

  it("non-Bearer scheme / empty value / scheme only -> other-scheme (challenge carries no error)", () => {
    // RFC 6750 section 3: for an unsupported authentication method the challenge SHOULD NOT carry an error code, unlike a
    // Bearer with a bad token (invalid_token), hence three separate states.
    expect(parseAuthorizationHeader("Basic dXNlcjpwdw==")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("   ")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer   ")).toEqual({ kind: "other-scheme" });
  });

  it("no whitespace inside the token: `Bearer a b` is malformed, not the token 'a b'", () => {
    expect(parseAuthorizationHeader("Bearer knb_a knb_b")).toEqual({ kind: "other-scheme" });
  });

  it("only SP/HTAB may separate scheme and token, not NBSP", () => {
    // RFC 7235 credentials allow only SP/HTAB. With a `\s+` separator, JS `\s` includes U+00A0, and Node decodes header values as
    // latin1 so byte 0xA0 really becomes U+00A0, which would turn a malformed header into a valid Bearer. This covers the separator
    // half (the `\S+` half is covered by the previous test).
    expect(parseAuthorizationHeader("Bearer\u00a0knb_abc")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer\tknb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
  });

  it("similar prefixes that are not Bearer must not match (BearerToken/Bearerx)", () => {
    expect(parseAuthorizationHeader("BearerToken knb_abc")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearerknb_abc")).toEqual({ kind: "other-scheme" });
  });
});

describe("buildBearerChallenge", () => {
  const issuer = "http://192.168.1.50:3000";
  const prm = `resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp"`;

  it("no-credential form: carries scope and resource_metadata, no error", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read" });
    expect(value.startsWith("Bearer ")).toBe(true);
    expect(value).toContain(`scope="notes:read"`);
    expect(value).toContain(prm);
    expect(value).not.toContain("error=");
  });

  it("bad-token form: carries error=invalid_token", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read notes:write", error: "invalid_token" });
    expect(value).toContain(`error="invalid_token"`);
    expect(value).toContain(`scope="notes:read notes:write"`);
    expect(value).toContain(prm);
  });

  it("insufficient-scope form: carries error=insufficient_scope", () => {
    expect(buildBearerChallenge({ issuer, scope: "notes:write", error: "insufficient_scope" })).toContain(
      `error="insufficient_scope"`
    );
  });

  it("resource_metadata points to /api/mcp regardless of the requested route", () => {
    // Deliberate deviation from RFC 9728 section 3.3, second paragraph (see the JSDoc in challenge.ts). Don't change it to "only for
    // /api/mcp": endpoints added after #106 would return a 401 with no discovery information.
    expect(buildBearerChallenge({ issuer, scope: "notes:read" })).toContain("/api/mcp");
  });

  it("issuer is used as given, no trailing slash added (otherwise ...//.well-known/... results)", () => {
    expect(buildBearerChallenge({ issuer: "https://notes.example.com", scope: "notes:read" })).toContain(
      `resource_metadata="https://notes.example.com/.well-known/oauth-protected-resource/api/mcp"`
    );
  });

  it("auth-params are comma-separated (RFC 7235 #rule) and every value is quoted", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read", error: "invalid_token" });
    // This catches joining the three parameters with spaces: invalid syntax that breaks client parsing.
    expect(value.split(", ")).toHaveLength(3);
    for (const param of value.replace(/^Bearer /, "").split(", ")) expect(param).toMatch(/^[a-z_]+="[^"]*"$/);
  });
});
