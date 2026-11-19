/** `client_name` is an unverified self-description shown on the consent page; this blocklist keeps characters (bidi, zero-width, control) from visually hiding the "not verified" note. With loopback-only redirects it is the only phishing defence. Scanned by code point so astral characters aren't split. */
export const DEFAULT_CLIENT_NAME = "MCP client";

export function hasUnsafeClientNameChar(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true; // C0 / DEL / C1
    if (code === 0x061c) return true; // ARABIC LETTER MARK
    if (code >= 0x200b && code <= 0x200f) return true; // zero-width, LRM/RLM
    if (code >= 0x2028 && code <= 0x202e) return true; // line/paragraph separators, LRE to RLO
    if (code >= 0x2066 && code <= 0x2069) return true; // isolates
  }
  return false;
}
