/**
 * #132: the two pure values the global content-type guard uses to decide whether "this request is an RFC-shaped prefix".
 * Placed at the unit level (no DB), so it can be checked on a local Windows machine without starting docker.
 */
import { describe, expect, it } from "vitest";
import { FORM_EXEMPT_ROUTES, isOauthScopedPath } from "../../src/http/oauth-errors.js";

describe("isOauthScopedPath", () => {
  it("both prefixes themselves and their subpaths count", () => {
    expect(isOauthScopedPath("/oauth")).toBe(true);
    expect(isOauthScopedPath("/oauth/token")).toBe(true);
    expect(isOauthScopedPath("/.well-known")).toBe(true);
    expect(isOauthScopedPath("/.well-known/oauth-authorization-server")).toBe(true);
  });

  // Segment boundary: a bare startsWith would also count /oauthx, which is an ordinary SPA path.
  it("segment boundary: a path that merely starts with the prefix doesn't count", () => {
    expect(isOauthScopedPath("/oauthx")).toBe(false);
    expect(isOauthScopedPath("/oauthx/token")).toBe(false);
    expect(isOauthScopedPath("/.well-knownx")).toBe(false);
  });

  it("unrelated paths don't count", () => {
    expect(isOauthScopedPath("/")).toBe(false);
    expect(isOauthScopedPath("/api/notes")).toBe(false);
  });
});

describe("FORM_EXEMPT_ROUTES", () => {
  // `routeOptions.url` inside a prefix plugin returns the full path including the prefix. Written as `/token` without the prefix,
  // the form endpoint would always get 415.
  it("keys are the full paths including the prefix", () => {
    expect(FORM_EXEMPT_ROUTES.has("POST /oauth/token")).toBe(true);
    expect(FORM_EXEMPT_ROUTES.has("POST /token")).toBe(false);
  });
});
