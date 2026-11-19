/** Backslash-escapes `\`, `%` and `_` so `s` matches literally inside a LIKE pattern (`\` is PostgreSQL's default ESCAPE). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}
