import { firstFoldedHit } from "@/lib/search-match";

/** Max code points kept before the hit (a sidebar line fits ~18 CJK chars while the server's leading context is up to ~50, so the hit was often cut out of view). */
export const SNIPPET_LEAD_MAX = 12;

/**
 * Positions in `toLowerCase()` output don't map back to the original when it changes length (e.g. `İ`): then the snippet is returned unchanged (same rule as `highlightTitle`).
 * A server-truncated snippet already starts with `…`; the trim always removes it, so there is no `……`. `lowerTerms` come from `forQuery`, not the current query;
 * the trim keeps context before the earliest hit of any keyword.
 */
export function displaySnippet(snippet: string, lowerTerms: readonly string[], leadMax: number = SNIPPET_LEAD_MAX): string {
  const hit = firstFoldedHit(snippet, lowerTerms);
  if (hit === null) return snippet;
  const index = hit.index;
  const before = Array.from(snippet.slice(0, index));
  if (before.length <= leadMax) return snippet;
  return `…${before.slice(before.length - leadMax).join("")}${snippet.slice(index)}`;
}
