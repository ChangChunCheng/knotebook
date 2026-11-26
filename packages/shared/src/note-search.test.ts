import { describe, expect, it } from "vitest";
import { parseSearchTerms, SEARCH_TERMS_MAX } from "./note-search.js";

describe("parseSearchTerms (#399)", () => {
  it("one keyword stays exactly as typed (same literal match as before)", () => {
    expect(parseSearchTerms("deploy")).toEqual(["deploy"]);
    expect(parseSearchTerms("50%_off")).toEqual(["50%_off"]);
    expect(parseSearchTerms("部署正式機")).toEqual(["部署正式機"]);
  });

  it("splits on any whitespace, including the ideographic space, and drops empty pieces", () => {
    expect(parseSearchTerms("  deploy\tprod\n backup ")).toEqual(["deploy", "prod", "backup"]);
    expect(parseSearchTerms("部署　正式機 備份")).toEqual(["部署", "正式機", "備份"]);
    expect(parseSearchTerms("   ")).toEqual([]);
  });

  it("a quoted phrase is one keyword with its inner whitespace kept", () => {
    expect(parseSearchTerms('"release notes" 2026')).toEqual(["release notes", "2026"]);
    expect(parseSearchTerms('"  two  spaces "')).toEqual(["  two  spaces "]);
    expect(parseSearchTerms('a"b c"d')).toEqual(["a", "b c", "d"]);
  });

  it("an unclosed quote runs to the end; blank phrases are dropped", () => {
    expect(parseSearchTerms('foo "bar baz')).toEqual(["foo", "bar baz"]);
    expect(parseSearchTerms('"" foo " "')).toEqual(["foo"]);
  });

  it("only quotes and whitespace: the trimmed query is one literal keyword, so a double quote can be searched for", () => {
    expect(parseSearchTerms('"')).toEqual(['"']);
    expect(parseSearchTerms(' "" ')).toEqual(['""']);
  });

  it("drops case-insensitive repeats, keeping the first spelling and the query order", () => {
    expect(parseSearchTerms("Deploy prod deploy PROD backup")).toEqual(["Deploy", "prod", "backup"]);
  });

  it(`returns null over ${SEARCH_TERMS_MAX} keywords (repeats don't count)`, () => {
    const eight = Array.from({ length: SEARCH_TERMS_MAX }, (_, i) => `k${i}`);
    expect(parseSearchTerms(eight.join(" "))).toEqual(eight);
    expect(parseSearchTerms([...eight, "k0"].join(" "))).toEqual(eight);
    expect(parseSearchTerms([...eight, "k9"].join(" "))).toBeNull();
  });
});
