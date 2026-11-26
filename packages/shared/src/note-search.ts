import type { NoteDto } from "./note-dto.js";

/** Query length in UTF-16 code units after trim (what zod `.max` counts); web uses these to decide when to send. */
export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_TERMS_MAX = 8;

/** `all`: a note must contain every keyword (each in its title or body); `any`: at least one. */
export type SearchTermsMode = "all" | "any";
export const SEARCH_TERMS_MODES = ["all", "any"] as const satisfies readonly SearchTermsMode[];

/**
 * #399: splits a search query into keywords, the one rule MCP, REST and the web share.
 * - Whitespace (`\s`, which includes the ideographic space U+3000) separates keywords; there is no word segmentation, so
 *   CJK keywords must be separated by spaces to count separately.
 * - `"…"` is one keyword with its inner whitespace kept; a `"` also ends the keyword before it, and an unclosed `"` runs to
 *   the end. Blank phrases are dropped; a query of only quotes and whitespace is one literal keyword (the trimmed query),
 *   so `"` itself can still be searched for.
 * - Keywords repeated case-insensitively (`toLowerCase`) keep their first spelling only.
 * Returns `[]` when nothing is left, or `null` when there are more than `SEARCH_TERMS_MAX` keywords.
 * One keyword (including one quoted phrase) means the same literal match as before #399.
 */
export function parseSearchTerms(query: string): string[] | null {
  const out = splitSearchTerms(query);
  return out.length > SEARCH_TERMS_MAX ? null : out;
}

/** `parseSearchTerms` without the keyword limit: the web's title filter still applies when there are too many keywords to search note text. */
export function splitSearchTerms(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    if (term.trim() === "") return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  let current = "";
  let inPhrase = false;
  for (const ch of query) {
    if (ch === '"') {
      push(current);
      current = "";
      inPhrase = !inPhrase;
    } else if (!inPhrase && /\s/u.test(ch)) {
      push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  push(current);
  if (out.length === 0 && query.trim() !== "") return [query.trim()];
  return out;
}

/** `sectionId` becomes the `#b-<sectionId>` anchor (except `_top`). */
export interface NoteSearchMatchDto {
  sectionId: string;
  heading: string;
  snippet: string;
  /** Only for a query with more than one keyword: the keywords this section contains, in query order. */
  matchedTerms?: string[];
}

export interface NoteSearchHitDto {
  note: NoteDto;
  matchedOn: "title" | "body" | "both";
  matches: NoteSearchMatchDto[];
  /** Only for a query with more than one keyword: the keywords this note contains (title or body), in query order. */
  matchedTerms?: string[];
}

export interface NoteSearchResultDto {
  hits: NoteSearchHitDto[];
  nextCursor: string | null;
}

export interface BacklinkDto {
  id: string;
  title: string;
  slug: string;
  ownerHandle: string | null;
  groupId: string | null;
}
