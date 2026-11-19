/**
 * Download and write-back must use the same functions: base hashes are computed over their
 * output, so two copies would diverge and every line would look changed.
 * `lineKey` is `trimEnd()`, which unlike `/[ \t]+$/` also eats NBSP and U+3000, so a change
 * to trailing Unicode whitespace alone isn't written back (known-limitations).
 */

/** Keeps trailing whitespace on lines on purpose (it is line content; `lineKey` handles it when comparing). */
export function normalizeBody(s: string): string {
  return trimTrailingNewlines(
    s
      .replace(/^\ufeff/, "")
      .replace(/\r\n/g, "\n")
      .replace(/^(?:[ \t]*\n)+/, ""),
  );
}

/** Linear: `/\n+$/` is unanchored, so each newline consumed the whole run before failing (a long run of newlines took seconds on the main thread). */
export function trimTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  return end === s.length ? s : s.slice(0, end);
}

export function bodyLines(normalized: string): string[] {
  return normalized === "" ? [] : normalized.split("\n");
}

export function lineKey(line: string): string {
  return line.trimEnd();
}

/** Numbered segments: the leading number becomes `1.` so renumbering isn't a change. */
export function normalizeNumbered(line: string): string {
  return line.replace(/^(\s*)\d+\./, "$11.");
}
