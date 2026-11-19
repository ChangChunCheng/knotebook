import { describe, expect, it } from "vitest";
import { canonicalColumnsLine, columnOpenTag } from "@knotebook/shared";
import {
  addColumnWidths,
  changedIndices,
  dividerResize,
  equalHeightWidths,
  expandColumnPixels,
  ratiosFromPixels,
} from "./widths";

const sumCents = (r: readonly number[]) => Math.round(r.reduce((a, b) => a + b, 0) * 100);
/** Equal to the double `Math.round(v*100)/100` produces; `v*100` itself isn't always an integer (e.g. 1.1*100). */
const isTwoDecimals = (v: number) => Math.round(v * 100) / 100 === v;

describe("ratiosFromPixels", () => {
  it("sum equals the column count, each value has two decimals, within [0.1,10]", () => {
    for (const px of [[100, 300], [96, 2000], [1, 1, 1], [333, 333, 334, 1]]) {
      const r = ratiosFromPixels(px);
      expect(sumCents(r)).toBe(px.length * 100);
      for (const v of r) {
        expect(v).toBeGreaterThanOrEqual(0.1);
        expect(v).toBeLessThanOrEqual(10);
        expect(isTwoDecimals(v)).toBe(true);
      }
    }
  });

  it("extreme: [96, 2000] -> column 1 clamped at 0.1", () => expect(ratiosFromPixels([96, 2000])[0]).toBeCloseTo(0.1, 5));

  // The total 533 doesn't divide evenly, so most d produce a rounding difference; column 3 isn't in changed, so the difference can only land on columns 1/2, and column 3 is always 3x333/533 = 1.874 -> 1.87.
  it("changed: [100+d|100-d|333] changes only columns 1 and 2; over d=-40..40 column 3 is always 1.87 and the rounding difference lands only on columns 1 and 2", () => {
    let nonzero = 0;
    for (let d = -40; d <= 40; d++) {
      const px = [100 + d, 100 - d, 333];
      const s = px.reduce((a, b) => a + b, 0);
      if (px.reduce((a, p) => a + Math.round((3 * p * 100) / s), 0) !== 300) nonzero++; // precondition: this set produces a rounding difference
      const r = ratiosFromPixels(px, [0, 1]);
      expect(r[2]).toBe(1.87);
      expect(sumCents(r)).toBe(300);
    }
    expect(nonzero).toBeGreaterThan(0); // guards against a vacuous pass
  });

  it("the rounding difference goes to the column with the largest rounded value among changed; ties take the smaller index", () => {
    // [1,1,1]: each 1, no rounding difference. [2,2,2,1]: 4x2/7=1.142857 -> 1.14 x3, 0.571 -> 0.57, sum 3.99, the +0.01 difference goes to column 1 (ties take the smaller index).
    expect(ratiosFromPixels([2, 2, 2, 1])).toEqual([1.15, 1.14, 1.14, 0.57]);
    // changed = [1, 2]: the difference lands on the second column (index 1; indexes 1 and 2 tie at 1.14, the smaller index wins).
    expect(ratiosFromPixels([2, 2, 2, 1], [1, 2])).toEqual([1.14, 1.15, 1.14, 0.57]);
  });
});

/** Deterministic random numbers (mulberry32): the same seed always gives the same sequence. */
function mulberry32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it("every output passes through canonicalColumnsLine(columnOpenTag(w)) as non-null and equal to w itself (fixed seed, 1000 sets)", () => {
  const rand = mulberry32(42);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const outputs: number[][] = [];
  for (let i = 0; i < 1000; i++) {
    const n = int(2, 4);
    const px = Array.from({ length: n }, () => int(1, 3000));
    const k = int(0, n - 2);
    outputs.push(ratiosFromPixels(px));
    outputs.push(ratiosFromPixels(px, [k, k + 1]));
    outputs.push(equalHeightWidths(px.map((p) => p / int(1, 3000)))!);
    outputs.push(addColumnWidths(ratiosFromPixels(px.slice(0, Math.max(1, n - 1))), int(0, n - 1)));
  }
  for (const out of outputs) {
    for (const w of out) expect(canonicalColumnsLine(columnOpenTag(w))).toEqual({ width: w });
  }
});

describe("dividerResize", () => {
  it("clamped to [mL, pL+pR-mR], sum unchanged", () => {
    expect(dividerResize(300, 300, 200, 200, -500)).toEqual([200, 400]);
    expect(dividerResize(300, 300, 200, 96, 500)).toEqual([504, 96]);
    expect(dividerResize(300, 300, 200, 200, 37)).toEqual([337, 263]);
  });
});

describe("expandColumnPixels", () => {
  it("deducts in proportion to headroom", () => expect(expandColumnPixels([300, 400, 300], [96, 200, 200], 0, 150)).toEqual({ px: [450, 300, 250], granted: 150 }));
  it("need > total headroom of the other columns -> grants only the headroom", () =>
    expect(expandColumnPixels([300, 250], [96, 200], 0, 999)).toEqual({ px: [350, 200], granted: 50 }));
  it("need <= 0 changes nothing", () => expect(expandColumnPixels([300, 300], [96, 200], 0, -10)).toEqual({ px: [300, 300], granted: 0 }));
  it("other columns all at minimum width -> can't be dragged", () => expect(expandColumnPixels([300, 200], [96, 200], 0, 50)).toEqual({ px: [300, 200], granted: 0 }));
});

describe("equalHeightWidths / addColumnWidths", () => {
  it("column widths proportional to aspect ratio", () => expect(equalHeightWidths([2, 1])).toEqual([1.33, 0.67]));
  it("unknown or non-positive sizes -> null", () => {
    expect(equalHeightWidths([2, null])).toBeNull();
    expect(equalHeightWidths([2, 0])).toBeNull();
    expect(equalHeightWidths([2, -1])).toBeNull();
  });
  it("[0.5|1.5] add a column at the end: new column = average of existing, existing ratios unchanged -> [0.5|1.5|1]", () => expect(addColumnWidths([0.5, 1.5], 2)).toEqual([0.5, 1.5, 1]));
  it("add at the start: [1|3] -> new column 2 inserted as column 1, whole row normalized", () => expect(addColumnWidths([1, 3], 0)).toEqual([1, 0.5, 1.5]));
});

describe("changedIndices", () => {
  it("lists only columns whose values differ", () => {
    expect(changedIndices([1, 1, 1], [1.2, 0.8, 1])).toEqual([0, 1]);
    expect(changedIndices([0.5, 1.5], [0.5, 1.5])).toEqual([]);
  });
});
