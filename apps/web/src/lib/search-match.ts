/**
 * #93: the single matching rule for search hits (highlighting and snippet-click jump), mirroring the server's
 * `position(lower(q) in lower(body))` with no NFKC / full-width folding: adding NFKC here would jump to a block the
 * server does not count as a hit.
 * If `toLowerCase()` changes the length (e.g. `İ`), positions cannot be mapped back → -1 on both sides.
 */
export function foldedIndexOf(text: string, lowerQuery: string): number {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return -1;
  return lower.indexOf(lowerQuery);
}
