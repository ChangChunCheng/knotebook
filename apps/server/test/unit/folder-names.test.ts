import { describe, expect, it } from "vitest";
import {
  fallbackGroupFolderName,
  folderNameWithSuffix,
  normalizeFolderName,
  normalizeFolderNameLoose,
} from "../../src/folders/names.js";

const NUL = String.fromCodePoint(0);
const SMILE = "😀";

describe("normalizeFolderName (user input)", () => {
  const cases: Array<[string, string, ReturnType<typeof normalizeFolderName>]> = [
    ["NUL", `A${NUL}B`, { ok: false, reason: "unstorable" }],
    ["lone surrogate", "\uD800", { ok: false, reason: "unstorable" }],
    ["trim first: a trailing newline is removed", " A\n", { ok: true, name: "A" }],
    ["newline in the middle", "A\nB", { ok: false, reason: "control" }],
    ["Tab", "A\tB", { ok: false, reason: "control" }],
    ["DEL", "A\u007FB", { ok: false, reason: "control" }],
    ["C1 U+0085", "A\u0085B", { ok: false, reason: "control" }],
    ["C1 U+0080", "A\u0080B", { ok: false, reason: "control" }],
    ["C0 upper bound U+001F", "A\u001FB", { ok: false, reason: "control" }],
    ["C1 upper bound U+009F", "A\u009FB", { ok: false, reason: "control" }],
    ["outside the range U+0020 (space)", "A B", { ok: true, name: "A B" }],
    ["outside the range U+00A0 (NBSP)", "A\u00A0B", { ok: true, name: "A\u00A0B" }],
    ["line separator U+2028", "A\u2028B", { ok: false, reason: "control" }],
    ["paragraph separator U+2029", "A\u2029B", { ok: false, reason: "control" }],
    ["bidi U+202A", "A\u202AB", { ok: false, reason: "control" }],
    ["bidi U+202E (RLO)", "A\u202EB", { ok: false, reason: "control" }],
    ["bidi U+2066", "A\u2066B", { ok: false, reason: "control" }],
    ["bidi U+2069", "A\u2069B", { ok: false, reason: "control" }],
    ["outside the range U+2027", "A\u2027B", { ok: true, name: "A\u2027B" }],
    ["outside the range U+202F", "A\u202FB", { ok: true, name: "A\u202FB" }],
    ["outside the range U+2065", "A\u2065B", { ok: true, name: "A\u2065B" }],
    ["outside the range U+206A", "A\u206AB", { ok: true, name: "A\u206AB" }],
    ["ZWNJ kept", "A\u200CB", { ok: true, name: "A\u200CB" }],
    ["ZWJ emoji sequence kept", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", { ok: true, name: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" }],
    ["NFC", "e\u0301", { ok: true, name: "\u00E9" }],
    ["80 smiling-face emoji (counted by code point)", SMILE.repeat(80), { ok: true, name: SMILE.repeat(80) }],
    ["81 a's", "a".repeat(81), { ok: false, reason: "length" }],
    ["empty string", "", { ok: false, reason: "length" }],
    ["whitespace only", "   ", { ok: false, reason: "length" }],
    ["other storable characters unchanged", "a/b›c", { ok: true, name: "a/b›c" }],
  ];
  it.each(cases)("%s", (_label, raw, expected) => {
    expect(normalizeFolderName(raw)).toEqual(expected);
  });
});

describe("normalizeFolderNameLoose (system-created)", () => {
  it("all control characters -> fallback", () => {
    expect(normalizeFolderNameLoose("\u0001\u0002", "Group")).toBe("Group");
  });
  it("strips control characters, then trims", () => {
    expect(normalizeFolderNameLoose("A\u0001 ", "Group")).toBe("A");
    expect(normalizeFolderNameLoose("A \u0001", "Group")).toBe("A");
    expect(normalizeFolderNameLoose("\u0001 A", "Group")).toBe("A");
  });
  it("NUL is removed", () => {
    expect(normalizeFolderNameLoose(`A${NUL}B`, "Group")).toBe("AB");
  });
  it("lone surrogate is removed", () => {
    expect(normalizeFolderNameLoose("\uD800X", "Group")).toBe("X");
    expect(normalizeFolderNameLoose("\u{1F3A8} 設計", "Group")).toBe("\u{1F3A8} 設計");
  });
  it("line separator and bidi controls are removed, ZWNJ/ZWJ kept", () => {
    expect(normalizeFolderNameLoose("A\u2028B\u2029C\u202AD\u202EE\u2066F\u2069G", "Group")).toBe("ABCDEFG");
    expect(normalizeFolderNameLoose("A\u200CB\u200DC", "Group")).toBe("A\u200CB\u200DC");
  });
  it("NFD -> NFC", () => {
    expect(normalizeFolderNameLoose("e\u0301", "Group")).toBe("\u00E9");
  });
  it("truncated to 80 code points", () => {
    expect(normalizeFolderNameLoose("字".repeat(100), "Group")).toBe("字".repeat(80));
  });
  it("no trailing whitespace after truncation", () => {
    expect(normalizeFolderNameLoose(`${"a".repeat(79)} bb`, "Group")).toBe("a".repeat(79));
  });
});

describe("folderNameWithSuffix", () => {
  it("80 a's with n=2 -> 76 a's + ' (2)'", () => {
    const r = folderNameWithSuffix("a".repeat(80), 2);
    expect(r).toBe(`${"a".repeat(76)} (2)`);
    expect(Array.from(r).length).toBe(80);
  });
  it("n=10 -> 75 a's + ' (10)'", () => {
    expect(folderNameWithSuffix("a".repeat(80), 10)).toBe(`${"a".repeat(75)} (10)`);
  });
  it("short names are not truncated", () => {
    expect(folderNameWithSuffix("ab", 2)).toBe("ab (2)");
  });
  it("trimEnd after truncation, no double space", () => {
    const base = `${"a".repeat(75)}  zz`;
    expect(Array.from(base).length).toBe(79);
    expect(folderNameWithSuffix(base, 2)).toBe(`${"a".repeat(75)} (2)`);
  });
  it("an emoji counts as 1 code point", () => {
    const r = folderNameWithSuffix(SMILE.repeat(80), 2);
    expect(r).toBe(`${SMILE.repeat(76)} (2)`);
    expect(Array.from(r).length).toBe(80);
  });
  it("n=1 -> base", () => {
    expect(folderNameWithSuffix("ab", 1)).toBe("ab");
  });
});

describe("fallbackGroupFolderName", () => {
  it.each(["zh-TW,zh;q=0.9", "zh", " ZH-cn"])("%j -> the Chinese default name", (al) => {
    expect(fallbackGroupFolderName(al)).toBe("群組");
  });
  it.each(["en-US,zh-TW;q=0.9", "", undefined])("%j -> Group", (al) => {
    expect(fallbackGroupFolderName(al)).toBe("Group");
  });
});
