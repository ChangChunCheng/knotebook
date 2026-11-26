import { parseSearchTerms, SEARCH_QUERY_MAX } from "@knotebook/shared";

/** Min length counts code points (a CJK char = 1); max counts UTF-16 code units, what the server's zod `.max` counts. Over max → `tooLong`, over `SEARCH_TERMS_MAX` keywords → `tooManyTerms`, no request; one char or too long doesn't even load the lazy chunk. */
export const BODY_SEARCH_MIN_CHARS = 2;
/** Debounce (ms) for body search; used in the first-bundle `SearchResults` (inside the lazy component every mount would fire at once). */
export const BODY_SEARCH_DEBOUNCE_MS = 300;

export type BodyGate = "off" | "tooShort" | "tooLong" | "tooManyTerms" | "search";

export function bodySearchGate(raw: string): BodyGate {
  const q = raw.trim();
  if (q === "") return "off";
  if (Array.from(q).length < BODY_SEARCH_MIN_CHARS) return "tooShort";
  if (q.length > SEARCH_QUERY_MAX) return "tooLong";
  if (parseSearchTerms(q) === null) return "tooManyTerms";
  return "search";
}
