/** Shared by batch add and the suggestions combobox so splitting and caret-token lookup never disagree. */

const SEGMENT_SEPARATORS = ",;，；、\\r\\n";
const PIECE_SEPARATORS = "\\s<>";

export const SEGMENT_SEPARATOR_RE = new RegExp(`[${SEGMENT_SEPARATORS}]+`);
export const PIECE_RE = new RegExp(`<([^<>]*)>|[^${PIECE_SEPARATORS}]+`, "g");
const BOUNDARY_RE = new RegExp(`[${SEGMENT_SEPARATORS}${PIECE_SEPARATORS}]`);
const BOUNDARIES_RE = new RegExp(`[${SEGMENT_SEPARATORS}${PIECE_SEPARATORS}]+`);
const LEADING_SEPARATOR_RE = new RegExp(`^\\s*[${SEGMENT_SEPARATORS}]\\s*`);

export interface TokenSpan {
  start: number;
  end: number;
  token: string;
}

export function tokenAt(text: string, caret: number): TokenSpan {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !BOUNDARY_RE.test(text[start - 1]!)) start -= 1;
  let end = at;
  while (end < text.length && !BOUNDARY_RE.test(text[end]!)) end += 1;
  return { start, end, token: text.slice(start, end) };
}

export function otherTokens(text: string, start: number, end: number): string[] {
  return `${text.slice(0, start)} ${text.slice(end)}`.split(BOUNDARIES_RE).filter((token) => token.length > 0);
}

/**
 * Appends `, ` only when no segment separator follows yet (reuses one when editing a middle
 * address); inside `Name <address>` brackets no separator is added and the caret goes after `>`.
 */
export function replaceToken(text: string, start: number, end: number, email: string): { text: string; caret: number } {
  const before = text.slice(0, start) + email;
  const after = text.slice(end);
  if (after.startsWith(">")) {
    const separator = LEADING_SEPARATOR_RE.exec(after.slice(1));
    return { text: before + after, caret: before.length + 1 + (separator?.[0].length ?? 0) };
  }
  const existing = LEADING_SEPARATOR_RE.exec(after);
  if (existing) return { text: before + after, caret: before.length + existing[0].length };
  return { text: `${before}, ${after.replace(/^\s+/, "")}`, caret: before.length + 2 };
}
