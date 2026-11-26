import { describe, expect, it } from "vitest";
import { bodySearchGate } from "./body-search-gate";

describe("bodySearchGate (needs at least 2 characters; over 200 code units is not searched)", () => {
  it.each([
    ["", "off"],
    ["  ", "off"],
    ["a", "tooShort"],
    ["中", "tooShort"],
    [" a ", "tooShort"],
    ["😀", "tooShort"], // 1 code point, 2 code units
    ["ab", "search"],
    ["中文", "search"],
    [" ab ", "search"],
    ["a".repeat(200), "search"],
    ["a".repeat(201), "tooLong"],
    ["😀".repeat(100), "search"], // 200 code units
    ["😀".repeat(101), "tooLong"], // 101 code points, 202 code units
    ["a b c d e f g h", "search"], // #399: 8 keywords
    ["a b c d e f g h i", "tooManyTerms"],
    ["a b c d e f g h a", "search"], // a repeat doesn't count
  ] as const)("%j -> %s", (raw, gate) => {
    expect(bodySearchGate(raw)).toBe(gate);
  });
});
