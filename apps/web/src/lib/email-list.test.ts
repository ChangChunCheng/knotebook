import { describe, expect, it } from "vitest";
import { parseEmailList } from "@/components/groups/bulk-add";
import { otherTokens, replaceToken, tokenAt } from "./email-list";

const SEPARATORS = [",", ";", "，", "；", "、", "\n", "\r\n", " ", "\t", "　", ", ", "；　"];

describe("lib/email-list", () => {
  it("uses the same separators as parseEmailList: wherever it can split, the address under the cursor also breaks there", () => {
    for (const sep of SEPARATORS) {
      const text = `a@x.com${sep}an`;
      expect(parseEmailList(text).all, JSON.stringify(sep)).toEqual(["a@x.com", "an"]);
      expect(tokenAt(text, text.length), JSON.stringify(sep)).toEqual({ start: text.length - 2, end: text.length, token: "an" });
      expect(otherTokens(text, text.length - 2, text.length), JSON.stringify(sep)).toEqual(["a@x.com"]);
    }
  });

  it("`name <address>`: angle brackets are also boundaries", () => {
    const text = "Ann <an";
    expect(tokenAt(text, text.length).token).toBe("an");
  });

  it("tokenAt: cursor inside an address takes the whole address; on a separator gives an empty fragment; out of range is clamped", () => {
    expect(tokenAt("a@x.com, bob, c@y.com", 11)).toEqual({ start: 9, end: 12, token: "bob" });
    expect(tokenAt("a@x.com, ", 9)).toEqual({ start: 9, end: 9, token: "" });
    expect(tokenAt("an", 99)).toEqual({ start: 0, end: 2, token: "an" });
  });

  it("replaceToken: last one -> appends ', '; a middle one -> keeps the original separator; other addresses unchanged", () => {
    expect(replaceToken("a@x.com，an", 8, 10, "ann@x.com")).toEqual({ text: "a@x.com，ann@x.com, ", caret: 19 });
    expect(replaceToken("a@x.com, an, c@y.com", 9, 11, "ann@x.com")).toEqual({ text: "a@x.com, ann@x.com, c@y.com", caret: 20 });
    expect(replaceToken("an；c@y.com", 0, 2, "ann@x.com")).toEqual({ text: "ann@x.com；c@y.com", caret: 10 });
    // A next address separated only by whitespace: append ", " and drop the whitespace.
    expect(replaceToken("an c@y.com", 0, 2, "ann@x.com")).toEqual({ text: "ann@x.com, c@y.com", caret: 11 });
  });

  it("replaceToken: for the address inside `name <address>` brackets (immediately followed by `>`) no separator is appended, and the cursor goes after `>` (and the separator after it)", () => {
    expect(replaceToken("Ann <an>", 5, 7, "ann@x.com")).toEqual({ text: "Ann <ann@x.com>", caret: 15 });
    expect(replaceToken("Ann <an>, c@y.com", 5, 7, "ann@x.com")).toEqual({ text: "Ann <ann@x.com>, c@y.com", caret: 17 });
    expect(parseEmailList("Ann <ann@x.com>, c@y.com").all).toEqual(["ann@x.com", "c@y.com"]);
  });
});
