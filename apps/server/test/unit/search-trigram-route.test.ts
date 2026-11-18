/** Only queries with 3+ consecutive letters/digits take the trigram (LIKE) path; a wrong guess costs speed, never correctness. */
import { describe, expect, it } from "vitest";
import { usesTrigramPath } from "../../src/notes/search-sql.js";

describe("usesTrigramPath", () => {
  it.each(["ab", "鯨魚", "a b c", "a-b-c", "ab_c", "😀😀😀", "%_\\"])("%s → position", q => {
    expect(usesTrigramPath(q)).toBe(false);
  });
  it.each(["abc", "x1y", "資料庫", "foo bar", "50%_off", "100%", "Résumé"])("%s → trigram", q => {
    expect(usesTrigramPath(q)).toBe(true);
  });
});
