/**
 * #132: two criteria: DCR intake (loopback-only) and the comparison at authorization (port ignored).
 * These are half of the phishing defence, so the boundaries are pinned cell by cell.
 */
import { describe, expect, it } from "vitest";
import { isLoopbackRedirectUri, matchesLoopbackRedirect } from "../../src/oauth/redirect.js";

describe("isLoopbackRedirectUri (the DCR intake criterion)", () => {
  it("accepts the three loopback hosts, any port and path", () => {
    expect(isLoopbackRedirectUri("http://localhost/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:5678/callback")).toBe(true);
    expect(isLoopbackRedirectUri("https://127.0.0.1/cb")).toBe(true);
  });

  // Only hostname excludes the port: judging by host would reject every loopback with a port.
  it("accepts a loopback with a port (judged by hostname)", () => {
    expect(isLoopbackRedirectUri("http://localhost:65535/cb")).toBe(true);
  });

  // Both prefix and suffix forms are needed: blocking only the prefix would let a set comparison swapped for endsWith stay green,
  // and `mylocalhost` is a really resolvable LAN host name.
  it("rejects remote hosts that look like loopback (prefix and suffix forms)", () => {
    expect(isLoopbackRedirectUri("http://localhost.evil.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://mylocalhost/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://evil.localhost/cb")).toBe(false);
  });

  // The DCR intake predicate rejects forms with credentials: the comparison side ignores userinfo entirely, so accepting them would make
  // the two sides disagree about who this is.
  it("rejects forms with userinfo", () => {
    expect(isLoopbackRedirectUri("http://user:pw@127.0.0.1/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://user@localhost/cb")).toBe(false);
    // A password-only form: a predicate cut down to look only at username would let it through
    expect(isLoopbackRedirectUri("http://:pw@127.0.0.1/cb")).toBe(false);
  });

  it("rejects remote https, non-http(s) schemes, query and fragment", () => {
    expect(isLoopbackRedirectUri("https://example.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("myapp://127.0.0.1/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb?x=1")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb#f")).toBe(false);
  });

  // NUL and lone surrogates: `new URL()` accepts them but jsonb can't store them (22P05): without blocking them an unauthenticated endpoint returns 500
  it("rejects forms containing NUL or a lone surrogate (jsonb can't store them)", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1/a\u0000b")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/a\uD800b")).toBe(false);
    // Positive control: a paired surrogate is a valid astral character and must not be blocked
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb-\u{1F600}")).toBe(true);
  });

  it("rejects strings that can't be parsed", () => {
    expect(isLoopbackRedirectUri("/cb")).toBe(false);
  });
});

describe("matchesLoopbackRedirect (comparison at authorization, port ignored)", () => {
  it("a different port still matches (RFC 8252 section 7.3 MUST)", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1:1234/cb", "http://127.0.0.1:5678/cb")).toBe(true);
  });

  // "Verbatim equality" must be verbatim: the case-sensitivity case catches a toLowerCase variant, the prefix case catches a startsWith variant
  // (the latter would loosen a registered /cb into accepting /cbx, loosening the comparison base by one notch).
  it("a different path doesn't match, and the comparison is verbatim (case-sensitive, not prefix)", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1:1234/cb", "http://127.0.0.1:1234/other")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/CB")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cbx")).toBe(false);
    // The other direction too: the other side of the startsWith variant (registering /cbx accepts an actual /cb)
    expect(matchesLoopbackRedirect("http://127.0.0.1/cbx", "http://127.0.0.1/cb")).toBe(false);
  });

  it("a different hostname doesn't match (localhost and 127.0.0.1 are different things)", () => {
    expect(matchesLoopbackRedirect("http://localhost:1234/cb", "http://127.0.0.1:1234/cb")).toBe(false);
  });

  it("a different scheme doesn't match", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "https://127.0.0.1/cb")).toBe(false);
  });

  it("a query or fragment on either side doesn't match", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb?x=1")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb?x=1", "http://127.0.0.1/cb")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb#f")).toBe(false);
  });

  it("userinfo on either side doesn't match", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://u:p@127.0.0.1/cb")).toBe(false);
    expect(matchesLoopbackRedirect("http://u:p@127.0.0.1/cb", "http://127.0.0.1/cb")).toBe(false);
  });

  // A percent-encoded %00 can be registered legitimately, and a bare NUL's pathname equals it after normalization: letting it through would store
  // the raw actual in the database and blow up with 500 (the actual value is what gets stored).
  it("NUL or a lone surrogate on either side doesn't match (even if equal after normalization)", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb%00", "http://127.0.0.1/cb\u0000")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb\u0000", "http://127.0.0.1/cb%00")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb\uD800")).toBe(false);
  });

  it("either side unparsable doesn't match", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "not a url")).toBe(false);
  });
});
