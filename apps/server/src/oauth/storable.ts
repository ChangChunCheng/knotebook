/** NUL and lone surrogates pass `new URL()` and length checks but Postgres rejects them (22021/22P05/22P02): a 500 anyone could trigger. `\p{Surrogate}` matches only lone ones. */
const UNSTORABLE_CHAR_RE = /[\0]|\p{Surrogate}/u;

export function hasUnstorableChar(value: string): boolean {
  return UNSTORABLE_CHAR_RE.test(value);
}
