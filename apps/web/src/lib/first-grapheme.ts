const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}]/gu;
const LEADING_INVISIBLE = /^[\p{Cc}\p{Cf}\p{Z}]+/u;

export function hasVisibleText(name: string): boolean {
  return name.replace(INVISIBLE, "") !== "";
}

/** Only leading invisible characters are stripped, so ZWJ ligatures are unaffected. */
export function firstGrapheme(name: string): string {
  if (!hasVisibleText(name)) return "?";
  const s = name.replace(LEADING_INVISIBLE, "");
  const first = segmenter ? segmenter.segment(s)[Symbol.iterator]().next().value?.segment : [...s][0];
  return (first ?? "?").toUpperCase();
}
