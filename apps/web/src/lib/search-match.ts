import { splitSearchTerms } from "@knotebook/shared";

/**
 * #93: the single matching rule for search hits (highlighting and snippet-click jump), mirroring the server's
 * `position(lower(q) in lower(body))` with no NFKC / full-width folding: adding NFKC here would jump to a block the
 * server does not count as a hit.
 * Callers pass the query already lowercased. If `toLowerCase()` changes the length (e.g. `İ`), positions cannot be
 * mapped back → -1: no highlight and the jump falls back to the section heading, consistently.
 */
export function foldedIndexOf(text: string, lowerQuery: string): number {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return -1;
  return lower.indexOf(lowerQuery);
}

/** #399: the query's keywords, lowercased, by the shared `splitSearchTerms` rule (no keyword limit). */
export function lowerSearchTerms(query: string): string[] {
  return splitSearchTerms(query).map((t) => t.toLowerCase());
}

/** The earliest hit of any keyword (the longest one when several start there); null when none is found or positions can't be mapped back. */
export function firstFoldedHit(text: string, lowerTerms: readonly string[]): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const term of lowerTerms) {
    if (term === "") continue;
    const index = foldedIndexOf(text, term);
    if (index < 0) continue;
    if (best === null || index < best.index || (index === best.index && term.length > best.length)) best = { index, length: term.length };
  }
  return best;
}

/** The first hit of each keyword, merged where they overlap, in text order (what the sidebar highlights). */
export function foldedHitRanges(text: string, lowerTerms: readonly string[]): Array<{ start: number; end: number }> {
  const ranges = lowerTerms
    .filter((term) => term !== "")
    .map((term) => ({ start: foldedIndexOf(text, term), end: 0, len: term.length }))
    .filter((r) => r.start >= 0)
    .map((r) => ({ start: r.start, end: r.start + r.len }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
