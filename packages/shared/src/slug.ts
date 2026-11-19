const SLUG_CHARSET_RE = /^[\p{L}\p{N}-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(["new"]);

/** Must match the DB unique comparison for slugs; validateSlug expects its output. */
export function normalizeSlug(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

// Input must already be `normalizeSlug`ed. No `\p{M}` on purpose (e.g. U+0307 from `"İ".toLowerCase()`). `uuid_like` keeps
// slugs distinct from legacy `/notes/<vanity>-<id>` links, which still resolve via `extractRefUuid`.
export function validateSlug(normalized: string): "length" | "charset" | "dash" | "reserved" | "uuid_like" | null {
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) return "length";
  if (!SLUG_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (RESERVED_SLUGS.has(normalized)) return "reserved";
  if (UUID_RE.test(normalized) || UUID_SUFFIX_RE.test(normalized)) return "uuid_like";
  return null;
}

const HANDLE_CHARSET_RE = /^[a-z0-9-]+$/;

// Maps only ASCII A-Z to a-z, unlike normalizeSlug: handles are URL identities and must be typeable everywhere and safe
// from IDN homographs, so no Unicode lowercasing (U+0307 from "İ") or transliteration; non-ASCII is left for
// validateHandle to reject.
export function normalizeHandle(input: string): string {
  // +32 rather than toLowerCase(), so the no-Unicode-lowercase rule is visible.
  return input.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

// No reserved words, unlike validateSlug: handles only appear as the second segment of /n/ and /p/ (shared-handle.test.ts).
// `uuid_like` is unreachable under the 32 limit; kept in case the limit grows.
export function validateHandle(normalized: string): "length" | "charset" | "dash" | "uuid_like" | null {
  // Code points, so long non-ASCII input reports `charset` rather than `length`.
  const length = Array.from(normalized).length;
  if (length < 1 || length > 32) return "length";
  if (!HANDLE_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (UUID_RE.test(normalized)) return "uuid_like";
  return null;
}

// No case folding: callers needing uniqueness apply normalizeSlug. Truncation counts code points (no split surrogate
// pairs), then trims `-` again because the cut may land after one.
export function titleSlug(title: string): string {
  let s = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-");
  s = s.replace(/^-+|-+$/g, "");
  const chars = Array.from(s);
  if (chars.length > 60) {
    s = chars.slice(0, 60).join("");
  }
  s = s.replace(/-+$/, "");
  return s;
}

// Valid candidates pass unchanged (accents, CJK kept); the fallback strips diacritics from the whole string. The result is
// always a fixed point of normalizeSlug (needed for unique matching); deduplication is the caller's job.
export function autoSlugFromTitle(title: string): string {
  const candidate = normalizeSlug(titleSlug(title));
  if (validateSlug(candidate) === null) return candidate;
  const stripped = candidate.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
  if (validateSlug(stripped) === null) return stripped;
  return "untitled";
}

/** Legacy `<vanity>-<uuid>` links must keep resolving. */
export function extractRefUuid(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref.toLowerCase();
  const match = UUID_SUFFIX_RE.exec(ref);
  if (match) return match[0].slice(1).toLowerCase();
  return null;
}

/** No URL encoding: the handle, group uuid and slug charsets can't contain `/ % ? #`; non-ASCII is left to the browser to encode. */
export function canonicalNotePath(note: { ownerHandle: string | null; groupId: string | null; slug: string }): string {
  // `typeof` rather than `!== null`: older objects without `groupId` (undefined) would otherwise give `/g/undefined/…`.
  if (typeof note.groupId === "string") return `/g/${note.groupId}/${note.slug}`;
  if (typeof note.ownerHandle === "string") return `/n/${note.ownerHandle}/${note.slug}`;
  throw new Error("canonicalNotePath: ownerHandle 與 groupId 皆為 null");
}

/** Build /p/ page URLs only here; no encoding, so pass a validated handle/slug. Public API URLs are built in web
 * `lib/public-note-ref.ts`, which encodes raw URL params on purpose. */
export function publicAliasPath(ref: { handle: string; slug: string }): string {
  return `/p/${ref.handle}/${ref.slug}`;
}
