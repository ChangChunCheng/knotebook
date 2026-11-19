/**
 * #131: the two pure functions shared by the login redirect (`packages/shared`).
 *
 * `isExcludedPath` (which paths must not get the SPA's index.html) is shared by `apps/server/src/http/spa.ts` and `safeNextPath`:
 * the criterion "this path is not an SPA page" must live in one place, otherwise the OIDC callback would send people to bare JSON.
 */
import { describe, expect, it } from "vitest";
import { EXCLUDED_PREFIXES, isExcludedPath, MAX_NEXT_PATH_LENGTH, safeNextPath } from "@knotebook/shared";

describe("isExcludedPath", () => {
  it("a bare prefix and its sub-paths both match", () => {
    expect(isExcludedPath("/api")).toBe(true);
    expect(isExcludedPath("/api/notes")).toBe(true);
    expect(isExcludedPath("/collab")).toBe(true);
    expect(isExcludedPath("/healthz")).toBe(true);
    expect(isExcludedPath("/assets/app.js")).toBe(true);
  });

  it("matches on segment boundaries, not string startsWith", () => {
    // Guards against simplifying the implementation to pathname.startsWith(prefix):
    // /collaborators is a valid SPA path and must not be caught by /collab.
    expect(isExcludedPath("/collaborators")).toBe(false);
    expect(isExcludedPath("/apifoo")).toBe(false);
    expect(isExcludedPath("/assetsx")).toBe(false);
  });

  it("the two prefixes added in #131: /oauth and /.well-known (RFC-shaped JSON from #132, not SPA pages)", () => {
    expect(isExcludedPath("/oauth")).toBe(true);
    expect(isExcludedPath("/oauth/token")).toBe(true);
    expect(isExcludedPath("/.well-known")).toBe(true);
    expect(isExcludedPath("/.well-known/oauth-authorization-server")).toBe(true);
    // same boundary rule: /.well-knownx is not a sub-path of /.well-known.
    expect(isExcludedPath("/.well-knownx")).toBe(false);
    expect(isExcludedPath("/oauthx")).toBe(false);
  });

  it("ordinary SPA paths do not match", () => {
    expect(isExcludedPath("/")).toBe(false);
    expect(isExcludedPath("/n/alice/my-note")).toBe(false);
    expect(isExcludedPath("/settings/account")).toBe(false);
    // The #132 consent page is the SPA path /authorize, **not under /oauth**. This line pins the reverse:
    // nobody puts /authorize (or /auth) into the list and leaves the consent page without the SPA fallback;
    // excluding /oauth does not affect it, so there is no reason to remove that prefix.
    expect(isExcludedPath("/authorize")).toBe(false);
  });

  it("does no normalisation: compares the raw string passed in", () => {
    // Pins the contract stated in the constant's comment. The two callers deliberately pass different shapes (spa.ts passes the undecoded
    // request.url, safeNextPath passes new URL(...).pathname), so this predicate must not do dot-segment collapsing
    // or slash merging itself - otherwise both callers' decisions would change silently.
    expect(isExcludedPath("/x/../api/notes")).toBe(false);
    // The token masking in routes/public.ts relies on this (it counts on //api/... not matching a prefix,
    // so it falls into the SPA fallback).
    expect(isExcludedPath("//api/notes")).toBe(false);
  });

  it("EXCLUDED_PREFIXES is exactly these six (think about the SPA fallback behaviour together with any new prefix)", () => {
    expect([...EXCLUDED_PREFIXES]).toEqual(["/api", "/collab", "/healthz", "/assets", "/oauth", "/.well-known"]);
  });
});

describe("safeNextPath", () => {
  it("valid in-site path: returned verbatim", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/x")).toBe("/x");
    expect(safeNextPath("/n/alice/my-note")).toBe("/n/alice/my-note");
    expect(safeNextPath("/n/alice/my-note?x=1")).toBe("/n/alice/my-note?x=1");
    expect(safeNextPath("/n/alice/my-note?x=1#frag")).toBe("/n/alice/my-note?x=1#frag");
    // segment boundary: /apifoo is not caught by /api.
    expect(safeNextPath("/apifoo")).toBe("/apifoo");
  });

  it("returns the raw input, not the normalised form - this is the open-redirect watershed", () => {
    // /..//evil passes every check (resolved relative to this site it is still this site), but new URL(...).pathname
    // normalises it to "//evil": sending the normalised form to Location/navigate would make the browser read it as a
    // protocol-relative URL and send the person to http://evil. Returning the raw string is harmless.
    expect(safeNextPath("/..//evil")).toBe("/..//evil");
    // The opposite mechanism: percent-encoding is **not** undone by the parser, so this string is just an odd
    // file name from start to end, a different cause from the case above.
    expect(safeNextPath("/%2F%2Fevil")).toBe("/%2F%2Fevil");
  });

  it("anything not starting with a single / is null (relative paths, empty string, other schemes)", () => {
    expect(safeNextPath("x")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath("?x=1")).toBeNull();
    expect(safeNextPath("#frag")).toBeNull();
    expect(safeNextPath("https://evil")).toBeNull();
    expect(safeNextPath("http://evil/x")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("cross-site shapes (a second character the parser would treat as an authority) are null", () => {
    expect(safeNextPath("//evil")).toBeNull();
    expect(safeNextPath("/\\evil")).toBeNull();
  });

  it("the four control characters named verbatim (control group)", () => {
    // The URL parser silently swallows CR/LF/TAB, so they must be rejected before parsing - Location header injection.
    expect(safeNextPath("/x\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/x\ny")).toBeNull();
    expect(safeNextPath("/x\ty")).toBeNull();
    // NUL: **build it with String.fromCharCode**; do not type a bare control character into the source.
    expect(safeNextPath("/x" + String.fromCharCode(0) + "y")).toBeNull();
  });

  it("non-visible ASCII is rejected: C0, space, DEL, latin-1, unencoded non-ASCII", () => {
    // A successful redirect is not encoded, so the string must be usable verbatim as Location (see safeNextPath's JSDoc).
    // Catches reverting to the four-character check and an upper bound that stops at U+007F.
    for (const code of [0x01, 0x0b, 0x0c, 0x1f, 0x7f]) {
      expect(safeNextPath("/x" + String.fromCharCode(code) + "y")).toBeNull();
    }
    expect(safeNextPath("/x y")).toBeNull();
    // Unencoded CJK path (/n/alice/<CJK>): from U+0100 up, Node's header validation throws
    // ERR_INVALID_CHAR. Built with fromCharCode to avoid NFC/NFD instability in the source.
    expect(safeNextPath("/n/alice/" + String.fromCharCode(0x7b46, 0x8a18))).toBeNull();
    // latin-1 (e-acute): Node's header validation actually lets it through, but it is rejected anyway - the criterion is a single rule
    // that does not follow downstream loosening.
    expect(safeNextPath("/x" + String.fromCharCode(0xe9) + "y")).toBeNull();
  });

  it("boundaries of visible ASCII and percent-encoded forms are accepted", () => {
    // 0x21 (!) and 0x7e (~) are the two ends of the visible range; neither may be rejected.
    expect(safeNextPath("/x!y")).toBe("/x!y");
    expect(safeNextPath("/x~y")).toBe("/x~y");
    // the encoded form is valid, and it is the form browsers actually send (location.pathname is encoded).
    expect(safeNextPath("/n/alice/%E7%AD%86%E8%A8%98")).toBe("/n/alice/%E7%AD%86%E8%A8%98");
  });

  it("length cap 2048 (inclusive)", () => {
    // The constant itself is pinned too: if only the constant were used to derive them, changing 2048 to 512 would leave both assertions green.
    expect(MAX_NEXT_PATH_LENGTH).toBe(2048);
    const atLimit = "/" + "a".repeat(2047);
    expect(atLimit).toHaveLength(2048);
    expect(safeNextPath(atLimit)).toBe(atLimit);
    expect(safeNextPath("/" + "a".repeat(2048))).toBeNull();
  });

  it("paths that are not SPA pages are null (otherwise login would land on bare JSON)", () => {
    expect(safeNextPath("/api")).toBeNull();
    expect(safeNextPath("/api/notes")).toBeNull();
    expect(safeNextPath("/collab/xyz")).toBeNull();
    expect(safeNextPath("/healthz")).toBeNull();
    expect(safeNextPath("/assets/app.js")).toBeNull();
    expect(safeNextPath("/oauth/token")).toBeNull();
    expect(safeNextPath("/.well-known/oauth-protected-resource")).toBeNull();
  });

  it("the exclusion check looks at the **resolved** pathname, not the raw string's literal prefix", () => {
    // Pins the implementation choice of feeding new URL(...).pathname to isExcludedPath.
    // (The contrast is in the isExcludedPath group above: asking the predicate directly with the same string is false.)
    expect(safeNextPath("/x/../api/notes")).toBeNull();
    // %2e%2e is restored by the parser to a dot-segment -> blocked as well.
    expect(safeNextPath("/x/%2e%2e/api/notes")).toBeNull();
    expect(safeNextPath("/x/%2E%2E/api/notes")).toBeNull();
    // Conversely %2f is **not** restored: this string's pathname is /x/..%2fapi/notes, which matches no
    // prefix, so it passes - redirecting there lands on the App.tsx /* catch-all (home page), not the API, so it is harmless.
    expect(safeNextPath("/x/..%2fapi/notes")).toBe("/x/..%2fapi/notes");
  });

  it("/login itself is not a valid target (a dead end back to the login form)", () => {
    expect(safeNextPath("/login")).toBeNull();
    expect(safeNextPath("/login?next=%2Fx")).toBeNull();
    // Trailing slash and case both need collapsing: react-router matching ignores trailing slashes and is case-insensitive by default,
    // so these shapes also render the login page.
    expect(safeNextPath("/login/")).toBeNull();
    // The `+` is load-bearing: react-router compiles an end route to `\/login\/*$`, so several trailing
    // slashes also render the login page; a `\/$` that eats only one slash would miss this shape.
    expect(safeNextPath("/login//")).toBeNull();
    expect(safeNextPath("/LOGIN")).toBeNull();
    // other paths that merely start with /login are not caught (not a prefix match).
    expect(safeNextPath("/loginx")).toBe("/loginx");
  });

  it("/link-account is not a valid target either (it exists only while not yet signed in and linking - #187)", () => {
    expect(safeNextPath("/link-account")).toBeNull();
    expect(safeNextPath("/link-account/")).toBeNull();
    expect(safeNextPath("/LINK-ACCOUNT")).toBeNull();
    expect(safeNextPath("/link-account?error=oidc_link_expired")).toBeNull();
    // not a prefix match: other paths with the same start are not caught.
    expect(safeNextPath("/link-accounts")).toBe("/link-accounts");
  });

  it("non-string input -> null (a query string can read back as null or an array)", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    // The fixture shape matters: for `?next=/&next=x` Fastify gives ["/", "x"], whose [0]
    // is "/", so this is the shape that proves the typeof guard is doing the guarding - with ["/x", "/y"]
    // removing the typeof line leaves the test green (input[0] !== "/" blocks it instead).
    expect(safeNextPath(["/", "x"] as unknown as string)).toBeNull();
  });
});

describe("#187: /register is excluded too (it exists only while not yet signed in)", () => {
  it.each(["/register", "/register/", "/REGISTER", "/Register//", "/register?next=%2Fx"])("%s -> null", (input) => {
    expect(safeNextPath(input)).toBeNull();
  });
  it("a similar prefix but a different page -> accepted", () => {
    expect(safeNextPath("/registered")).toBe("/registered");
    expect(safeNextPath("/n/alice/register")).toBe("/n/alice/register");
  });
});

describe("#286: /reset-password is excluded too (a signed-in person would only see \"please sign out first\")", () => {
  it.each(["/reset-password", "/reset-password/", "/RESET-PASSWORD"])("%s -> null", (input) => {
    expect(safeNextPath(input)).toBeNull();
  });
  it("a similar prefix but a different page -> accepted", () => {
    expect(safeNextPath("/reset-passwords")).toBe("/reset-passwords");
  });
});
