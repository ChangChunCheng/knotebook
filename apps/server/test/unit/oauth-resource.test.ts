/**
 * #132: the comparison criterion for the canonical resource identifier. The resource check at authorize and the two grant branches of
 * `/oauth/token` share this one, so its boundaries are pinned cell by cell.
 */
import { describe, expect, it } from "vitest";
import { canonicalResource, isCanonicalResource } from "../../src/oauth/resource.js";

const ISSUER = "http://host";

describe("canonicalResource", () => {
  it("is the issuer plus /api/mcp, no trailing slash", () => {
    expect(canonicalResource("http://host:3000")).toBe("http://host:3000/api/mcp");
  });
});

describe("isCanonicalResource", () => {
  it("accepts the verbatim equal form", () => {
    expect(isCanonicalResource("http://host/api/mcp", ISSUER)).toBe(true);
  });

  // scheme and host are normalized to lowercase by new URL, so an origin differing in case still matches
  it("accepts a scheme and host in different case", () => {
    expect(isCanonicalResource("HTTP://HOST/api/mcp", ISSUER)).toBe(true);
  });

  it("accepts an explicit default port", () => {
    expect(isCanonicalResource("http://host:80/api/mcp", ISSUER)).toBe(true);
  });

  it("path is case-sensitive", () => {
    expect(isCanonicalResource("http://host/API/MCP", ISSUER)).toBe(false);
  });

  it("rejects a trailing slash", () => {
    expect(isCanonicalResource("http://host/api/mcp/", ISSUER)).toBe(false);
  });

  it("rejects query or fragment", () => {
    expect(isCanonicalResource("http://host/api/mcp?x=1", ISSUER)).toBe(false);
    expect(isCanonicalResource("http://host/api/mcp#f", ISSUER)).toBe(false);
  });

  // An empty `?` gives search === "" but href keeps the trailing question mark: pins the design choice of comparing origin + pathname, not href
  // (switching to href would fail this case).
  it("accepts a form with only an empty query separator at the end", () => {
    expect(isCanonicalResource("http://host/api/mcp?", ISSUER)).toBe(true);
  });

  it("rejects a different host, a different port and non-URLs", () => {
    expect(isCanonicalResource("http://other/api/mcp", ISSUER)).toBe(false);
    expect(isCanonicalResource("http://host:3000/api/mcp", ISSUER)).toBe(false);
    expect(isCanonicalResource("not a url", ISSUER)).toBe(false);
  });

  it("absent (undefined) is false", () => {
    expect(isCanonicalResource(undefined, ISSUER)).toBe(false);
  });
});
