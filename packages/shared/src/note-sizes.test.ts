import { describe, expect, it } from "vitest";
import { SIZE_PX_MAX, SIZE_PX_MIN, clampSizePx, isSizePx } from "./note-sizes.js";

// Image widths and table column widths share this integer-px range.
describe("clampSizePx: non-finite or <= 0 -> null; otherwise rounded then clamped to [32, 4000]", () => {
  it.each<[number, number | null]>([
    [300, 300], [312.6, 313], [20, 32], [5000, 4000], [0, null], [-5, null], [NaN, null], [Infinity, null],
  ])("%s -> %s", (n, expected) => {
    expect(clampSizePx(n)).toBe(expected);
  });

  it("range constants", () => {
    expect([SIZE_PX_MIN, SIZE_PX_MAX]).toEqual([32, 4000]);
  });
});

describe("isSizePx: a decimal integer in [32, 4000], no leading 0, no whitespace", () => {
  it.each(["32", "4000", "300"])("%j -> true", s => {
    expect(isSizePx(s)).toBe(true);
  });
  it.each(["31", "4001", "0300", "300.5", " 300", "", "3e2"])("%j -> false", s => {
    expect(isSizePx(s)).toBe(false);
  });
});
