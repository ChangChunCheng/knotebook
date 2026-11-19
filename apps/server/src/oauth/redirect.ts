import { hasUnstorableChar } from "./storable.js";

// `new URL("http://[::1]/x").hostname` keeps the brackets, so the set holds "[::1]"; "fixing" it to `::1` breaks IPv6 loopback.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** A query would never match `matchesLoopbackRedirect` (search must be empty). The userinfo rejection is deliberate (stricter, don't delete it as redundant): matching ignores userinfo, so accepting it would let the two sides disagree on who the client is. */
export function isLoopbackRedirectUri(raw: string): boolean {
  if (hasUnstorableChar(raw)) return false;
  const url = parse(raw);
  if (url === null) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.search === "" && url.hash === "";
}

/** Port ignored per RFC 8252 §7.3 (MCP clients use ephemeral ports). */
export function matchesLoopbackRedirect(registered: string, actual: string): boolean {
  // Both sides: `.../cb\u0000` normalizes to `/cb%00` and would equal a legit `.../cb%00`, then store a raw value and 500.
  if (hasUnstorableChar(registered) || hasUnstorableChar(actual)) return false;
  const a = parse(registered);
  const b = parse(actual);
  if (a === null || b === null) return false;
  if (a.search !== "" || a.hash !== "" || b.search !== "" || b.hash !== "") return false;
  // DCR rejects userinfo, but the match ignores it, so require it empty on both sides too: an actual with credentials must not still match.
  if (a.username !== "" || a.password !== "" || b.username !== "" || b.password !== "") return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
}
