const START_TAG = /<[A-Za-z][^\s/>]*(?:\s+[^\s"'>/=]+="[^"]*")*\s*\/?>/g;
const UNSAFE = /<!--|<(?:script|style|xmp|iframe|noembed|noframes|noscript|plaintext|textarea|title)\b/i;

// Current browsers (Chromium 151, Firefox 153, WebKit 26.5) escape `<`/`>` in serialized attribute values and jsdom 30 doesn't; server and web output must match byte
// for byte, so use jsdom's form. Assumes innerHTML output without comments or raw-text elements (UNSAFE), where a
// literal `<` always starts a tag and attribute values have `"` as `&quot;`.
export function unescapeAttributeAngles(html: string): string {
  if (!html.includes("&lt;") && !html.includes("&gt;")) return html;
  if (UNSAFE.test(html)) return html;
  return html.replace(START_TAG, tag => tag.replace(/="[^"]*"/g, v => v.replaceAll("&lt;", "<").replaceAll("&gt;", ">")));
}
