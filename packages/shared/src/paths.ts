// Shared by the server SPA fallback (`http/spa.ts`) and `safeNextPath`; match on segment boundaries via isExcludedPath.
// `/oauth` and `/.well-known` 404s are RFC-shaped JSON, not SPA pages. The list is a closed set (pinned by
// shared-next-path.test.ts); spa.test.ts guards the fallback contract of the first four.
// The consent page `/authorize` is outside `/oauth`, so excluding `/oauth` is safe.
// No normalization: each caller passes what its side routes (spa.ts the raw URL, safeNextPath the parsed pathname);
// `routes/public.ts` token masking relies on `//api/public/…` not matching.
export const EXCLUDED_PREFIXES = ["/api", "/collab", "/healthz", "/assets", "/oauth", "/.well-known"] as const;

export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Server noindex, log masking and the web install prompt must all use this: the SPA fallback also serves `//p/…` and `/P/…`
// (React Router matches case-insensitively too). Bare /p counts so /p and /p/ behave alike.
export function isPublicSharePath(pathname: string): boolean {
  const p = pathname.replace(/^\/{2,}/, "/").toLowerCase();
  return p === "/p" || p.startsWith("/p/");
}

// Arbitrary but well below practical layer limits (nginx's 8 KB header buffer, old IE's 2083-char URL), so an absurdly long query
// fails at a clear point. Also bounds the OIDC state cookie: a 2048-char next sealed into it is 3049 bytes (3115 with Set-Cookie
// attributes), under 4 KB (reached at 2834 chars), so the server deliberately has no tighter limit (see
// apps/server/src/auth/oidc-state.ts).
export const MAX_NEXT_PATH_LENGTH = 2048;

// Fictional base, never contacted (`.invalid` is reserved by RFC 2606); only used to detect an origin change.
const NEXT_PATH_BASE = "http://knotebook.invalid";

const NEXT_PATH_CHARSET_RE = /^[\u0021-\u007e]+$/;

/**
 * Returns the input unchanged, never a normalized form: `/..//evil` passes, but its parsed pathname `//evil` would
 * redirect off-site as a protocol-relative URL. Returns null without a reason; callers silently fall back to "/".
 * - `typeof` is needed: parsed query strings can be arrays (`?next=/&next=x`).
 * - Length is `.length`, not code points as in validateSlug: it measures the string as a `Location` value, and after the
 *   charset check it is all ASCII, so both counts agree.
 * - The second character can't be `\` either: `\` equals `/` in special schemes, so `/\evil` would parse as an authority.
 * - The second-character check and the origin check are deliberately redundant; no input is stopped by the latter alone.
 *   The try/catch around `new URL` is unreachable too: with a valid base it doesn't throw.
 * - Visible ASCII only, checked before URL parsing (the parser silently drops CR/LF/TAB). The OIDC callback redirects to
 *   `next` unencoded because encoding at the redirect doesn't work (encodeURI double-encodes `%20`, encodeURIComponent
 *   mangles `/ ? #`). Node throws on C0 controls, DEL and header chars above U+00FF at writeHead, which runs after the
 *   handler returns (app.ts has an async onSend) and after the session cookie is set, so routes/oidc.ts's catch misses it
 *   and the user gets a JSON 500 instead of a 302. Callers must therefore pass percent-encoded paths (browser
 *   `location.pathname` already is).
 * - Excluded paths are matched on the parsed pathname, so `/x/../api/notes` is caught.
 * - Pages that only make sense logged out are dead ends after login (`/change-password` is not one: it works when logged
 *   in). Trailing slashes and case are folded first because react-router ignores both (`/login/` and `/LOGIN` render the
 *   login page).
 */
export function safeNextPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  if (input.length > MAX_NEXT_PATH_LENGTH) return null;
  if (input[0] !== "/") return null;
  if (input[1] === "/" || input[1] === "\\") return null;
  if (!NEXT_PATH_CHARSET_RE.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input, NEXT_PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== NEXT_PATH_BASE) return null;
  if (isExcludedPath(url.pathname)) return null;
  const collapsed = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (collapsed === "/login" || collapsed === "/link-account" || collapsed === "/register" || collapsed === "/reset-password") return null;

  return input;
}
