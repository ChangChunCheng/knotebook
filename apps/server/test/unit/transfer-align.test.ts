import { describe, it, expect } from "vitest";
import { GROUP_EXPORT_CAP, alignSegments, lineKindsOf, listFamily, type AlignSeg } from "../../src/transfer/align.js";

/** bulk transfer alignment; synthetic whole-note lines W, per-block lines P, and types - no editor needed. */

const P_ = "paragraph";
const BUL = "bulletListItem";
const NUM = "numberedListItem";
const noGroup = (): string[] => {
  throw new Error("groupExport should not be called");
};
const idxOf = (segs: AlignSeg[] | null) => segs?.map(s => s.idx) ?? null;

describe("listFamily", () => {
  it("numbered -> num; bullet/check/toggle -> star; others null", () => {
    expect(["numberedListItem", "bulletListItem", "checkListItem", "toggleListItem", "paragraph", "heading", "table"].map(listFamily)).toEqual([
      "num",
      "star",
      "star",
      "star",
      null,
      null,
      null,
    ]);
    expect(GROUP_EXPORT_CAP).toBe(32);
  });
});

describe("alignSegments", () => {
  it("two paragraphs get 1 blank line between them; lists of the same family joined get 0; start/count exact", () => {
    expect(alignSegments(["a", "", "b"], [["a"], ["b"]], [P_, P_], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 2, count: 1 },
    ]);
    expect(alignSegments(["* a", "* b"], [["* a"], ["* b"]], [BUL, BUL], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 1, count: 1 },
    ]);
  });

  it("priority: when both per-block and group match, per-block wins, and the group export is not called at all", () => {
    let calls = 0;
    const r = alignSegments(["* a", "* b"], [["* a"], ["* b"]], [BUL, BUL], () => {
      calls++;
      return ["* a", "* b"];
    });
    expect(idxOf(r.segs)).toEqual([[0], [1]]);
    expect(r.stats.groupCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("at the same position, a 1-line separator is tried before 0 lines (the order only shows when there are several solutions)", () => {
    const r = alignSegments(["A", "", "", "B"], [["A"], [], ["B"]], [P_, P_, P_], noGroup);
    expect(r.segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 2, count: 1 },
      { idx: [2], start: 3, count: 1 },
    ]);
  });

  it("leading and trailing empty paragraphs count as 0-line segments and do not eat blank lines", () => {
    expect(alignSegments(["A"], [[], ["A"], []], [P_, P_, P_], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 0 },
      { idx: [1], start: 0, count: 1 },
      { idx: [2], start: 1, count: 0 },
    ]);
    expect(alignSegments([], [[]], [P_], noGroup).segs).toEqual([{ idx: [0], start: 0, count: 0 }]);
  });

  it("numbered: numbering is stripped before comparing; the child-line indentation difference (delta) caused by number width also matches", () => {
    expect(idxOf(alignSegments(["1. a", "2. b"], [["1. a"], ["1. b"]], [NUM, NUM], noGroup).segs)).toEqual([[0], [1]]);
    expect(alignSegments(["10. n10", "    * child"], [["1. n10", "   * child"]], [NUM], noGroup).segs).toEqual([{ idx: [0], start: 0, count: 2 }]);
    // non-numbered types do not strip numbering
    expect(alignSegments(["2. b"], [["1. b"]], [P_], noGroup).segs).toBeNull();
  });

  it("table-row padding spaces and the separator row's - count are ignored; whitespace differences on non-table lines still do not match", () => {
    const r = alignSegments(["| a    | b |", "| ---- | --- |"], [["| a | b |", "| --- | ----- |"]], ["table"], noGroup);
    expect(r.segs).toEqual([{ idx: [0], start: 0, count: 2 }]);
    expect(alignSegments(["  | a  |"], [["  |a|"]], ["table"], noGroup).segs).not.toBeNull();
    expect(alignSegments(["a  b"], [["a b"]], [P_], noGroup).segs).toBeNull();
  });

  it("trailing whitespace is ignored (lineKey)", () => {
    expect(idxOf(alignSegments(["* a ", "\t", "b"], [["* a"], ["b  "]], [BUL, P_], noGroup).segs)).toEqual([[0], [1]]);
  });

  it("partial merging tries the longest first: 12 numbered items as one HTML line -> one segment, 1 group export; when only (0,5) matches, it tries from long to short, 7 times", () => {
    const P = Array.from({ length: 12 }, (_, i) => [`${i + 1}. n${i + 1}`]);
    const types = P.map(() => NUM);
    const html = "<ol><li>n1</li>…<li>n12</li></ol>";
    const calls: string[] = [];
    const r = alignSegments([html], P, types, (i, j) => {
      calls.push(`${i}-${j}`);
      return i === 0 && j === 11 ? [html] : ["nope"];
    });
    expect(r.segs).toEqual([{ idx: Array.from({ length: 12 }, (_, k) => k), start: 0, count: 1 }]);
    expect(r.stats.groupCalls).toBe(1);
    expect(calls).toEqual(["0-11"]);

    const html6 = "<ol><li>n1</li>…<li>n6</li></ol>";
    const W = [html6, ...Array.from({ length: 6 }, (_, k) => `${k + 7}. n${k + 7}`)];
    const calls2: string[] = [];
    const r2 = alignSegments(W, P, types, (i, j) => {
      calls2.push(`${i}-${j}`);
      return i === 0 && j === 5 ? [html6] : ["nope"];
    });
    expect(idxOf(r2.segs)).toEqual([[0, 1, 2, 3, 4, 5], [6], [7], [8], [9], [10], [11]]);
    expect(r2.stats.groupCalls).toBe(7);
    expect(calls2).toEqual(["0-11", "0-10", "0-9", "0-8", "0-7", "0-6", "0-5"]);
  });

  it("at most cap group exports per start point; past that the start point is abandoned", () => {
    const P = Array.from({ length: 12 }, (_, i) => [`${i + 1}. n${i + 1}`]);
    const calls: string[] = [];
    const r = alignSegments(["<ol>…</ol>"], P, P.map(() => NUM), (i, j) => {
      calls.push(`${i}-${j}`);
      return ["nope"];
    }, 3);
    expect(r.segs).toBeNull();
    expect(r.stats.capHits).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => c.startsWith("0-"))).toEqual(["0-11", "0-10", "0-9"]);
  });

  it("backtracking triggers the group: the 0th per-block matches but cannot continue -> only then does group (0,1) succeed", () => {
    const r = alignSegments(["* a", "x", "* b"], [["* a"], ["* b"]], [BUL, BUL], (i, j) => (i === 0 && j === 1 ? ["* a", "x", "* b"] : ["nope"]));
    expect(r.segs).toEqual([{ idx: [0, 1], start: 0, count: 3 }]);
    expect(r.stats.groupUsedWhilePerMatched).toBe(1);
    expect(r.stats.groupCalls).toBe(1);
  });

  it("no match -> null; leftover lines -> null; zero blocks: W empty -> [], W non-empty -> null", () => {
    expect(alignSegments(["a"], [["b"]], [P_], noGroup).segs).toBeNull();
    expect(alignSegments(["a", "", "b"], [["a"]], [P_], noGroup).segs).toBeNull();
    expect(alignSegments([], [], [], noGroup).segs).toEqual([]);
    expect(alignSegments(["a"], [], [], noGroup).segs).toBeNull();
    // an empty paragraph in the middle eats only blank lines (not lines with text)
    expect(alignSegments(["A", "x", "B"], [["A"], [], ["B"]], [P_, P_, P_], noGroup).segs).toBeNull();
  });

  it("failure memoisation is load-bearing: 30 empty paragraphs in the middle, 2 blank lines apart, the last block does not match -> null and < 500 ms (without memoisation it is exponential time)", () => {
    const W = ["A"];
    for (let k = 0; k < 30; k++) W.push("", "");
    W.push("", "Z");
    const P: string[][] = [["A"], ...Array.from({ length: 30 }, () => [] as string[]), ["B"]];
    const t0 = performance.now();
    const r = alignSegments(W, P, P.map(() => P_), noGroup);
    const ms = performance.now() - t0;
    expect(r.segs).toBeNull();
    expect(ms).toBeLessThan(500);
  });

  it("group export is cached by (i, j): reaching the same start point at a different position does not export again", () => {
    const calls: string[] = [];
    const r = alignSegments(["A", "", "", "x"], [["A"], [], ["* b"], ["* c"]], [P_, P_, BUL, BUL], (i, j) => {
      calls.push(`${i}-${j}`);
      return ["nope"];
    });
    expect(r.segs).toBeNull();
    expect(calls).toEqual(["2-3"]);
    expect(r.stats.groupCalls).toBe(1);
  });

  it("20 000 paragraphs: succeeds, no RangeError, < 500 ms; last block does not match -> null, and the failure path walks the whole backtrack without blowing up", () => {
    const n = 20_000;
    const P = Array.from({ length: n }, (_, i) => [`p${i}`]);
    const W: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) W.push("");
      W.push(`p${i}`);
    }
    const types = P.map(() => P_);
    const t0 = performance.now();
    const ok = alignSegments(W, P, types, noGroup);
    const ms = performance.now() - t0;
    expect(ok.segs).toHaveLength(n);
    expect(ok.segs![n - 1]).toEqual({ idx: [n - 1], start: 2 * (n - 1), count: 1 });
    expect(ms).toBeLessThan(500);

    const P2 = P.slice();
    P2[n - 1] = ["nomatch"];
    const t1 = performance.now();
    const bad = alignSegments(W, P2, types, noGroup);
    expect(bad.segs).toBeNull();
    expect(performance.now() - t1).toBeLessThan(500);
  });
});

describe("lineKindsOf", () => {
  it("lines of a segment containing numbered -> 1, others 0; segs=null -> all 0", () => {
    const segs: AlignSeg[] = [
      { idx: [0], start: 0, count: 1 },
      { idx: [1, 2], start: 2, count: 2 },
      { idx: [3], start: 4, count: 0 },
      { idx: [4], start: 5, count: 1 },
    ];
    expect(lineKindsOf(segs, [P_, BUL, NUM, P_, NUM], 6)).toEqual([0, 0, 1, 1, 0, 1]);
    expect(lineKindsOf(null, [NUM], 3)).toEqual([0, 0, 0]);
  });
});
