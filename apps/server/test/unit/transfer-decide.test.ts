import { describe, expect, it } from "vitest";
import type { TransferSegment } from "../../src/db/schema.js";
import { anchors, decide, matchesBase } from "../../src/transfer/decide.js";
import type { Region } from "../../src/transfer/regions.js";

/**
 * bulk transfer decision. A note changed since download gets a 409 `note_changed`, so `decide` is only called when the current state equals the base (`matchesBase`).
 */

/** Segments: one per name (1 id, 1 line); `~name` = a 0-line segment. */
function segsOf(...names: string[]): TransferSegment[] {
  let line = 0;
  return names.map(n => {
    const zero = n.startsWith("~");
    const id = zero ? n.slice(1) : n;
    const s = { ids: [id], fps: [`f:${id}`], start: line, count: zero ? 0 : 1 };
    line += zero ? 0 : 2;
    return s;
  });
}
function region(segs: TransferSegment[], kind: Region["kind"], segIdx: number[], prevSeg: number, nextSeg: number, text = kind === "delete" ? "" : "x"): Region {
  return { kind, segIdx, baseIds: segIdx.flatMap(k => segs[k]!.ids), baseFps: segIdx.flatMap(k => segs[k]!.fps), text, prevSeg, nextSeg };
}
/** Current = base (precondition): ids in the same order as the segment table. */
function curOf(segs: TransferSegment[], types: Record<string, string> = {}) {
  const ids = segs.flatMap(s => s.ids);
  return { ids, fps: segs.flatMap(s => s.fps), types: ids.map(id => types[id] ?? "paragraph") };
}
/** Fake canonical: id -> `c:<id>` (overridable); `pre[ri]` = the pre-parsed sequence of region ri. Records the region numbers received. */
function sameWith(pre: string[][], canon: Record<string, string> = {}, log: number[] = []) {
  return (ri: number, against: string[]) => {
    log.push(ri);
    const p = pre[ri] ?? [];
    return p.length === against.length && against.every((id, i) => (canon[id] ?? `c:${id}`) === p[i]);
  };
}

describe("matchesBase (the structural criterion for note_changed)", () => {
  const S = segsOf("A", "B", "~C");
  it("identical block by block -> true; empty segment table against empty current -> true", () => {
    expect(matchesBase(S, curOf(S))).toBe(true);
    expect(matchesBase([], { ids: [], fps: [] })).toBe(true);
  });
  it("one fingerprint different, id different, order different, one extra, one fewer -> false", () => {
    const c = curOf(S);
    expect(matchesBase(S, { ids: c.ids, fps: ["f:A", "g:B", "f:C"] })).toBe(false);
    expect(matchesBase(S, { ids: ["A", "B2", "C"], fps: c.fps })).toBe(false);
    expect(matchesBase(S, { ids: ["B", "A", "C"], fps: ["f:B", "f:A", "f:C"] })).toBe(false);
    expect(matchesBase(S, { ids: [...c.ids, "X"], fps: [...c.fps, "f:X"] })).toBe(false);
    expect(matchesBase(S, { ids: c.ids.slice(0, 2), fps: c.fps.slice(0, 2) })).toBe(false);
  });
  it("one segment with several blocks (group segment) is compared flattened", () => {
    const G: TransferSegment[] = [{ ids: ["a", "b"], fps: ["f:a", "f:b"], start: 0, count: 2 }];
    expect(matchesBase(G, { ids: ["a", "b"], fps: ["f:a", "f:b"] })).toBe(true);
    expect(matchesBase(G, { ids: ["a"], fps: ["f:a"] })).toBe(false);
  });
});

describe("decision table", () => {
  const S = segsOf("A", "B", "C");
  it("rewrite: pre-parsed = those base blocks -> same (untouched)", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S), sameWith([["c:B"]]));
    expect(d).toMatchObject({ mark: "same", survivors: ["B"], place: { replaceSurvivors: true } });
  });
  it("rewrite: pre-parsed differs -> applied, inserted before the first base block", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"], place: { ref: "B", where: "before" } });
  });
  it("rewrite of two segments: survivors = two blocks, placed before the first", () => {
    const S4 = segsOf("A", "B", "C", "D");
    const [d] = decide(S4, [region(S4, "rewrite", [1, 2], 0, 3)], curOf(S4), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B", "C"], place: { ref: "B", where: "before" } });
  });
  it("delete -> applied", () => {
    const [d] = decide(S, [region(S, "delete", [1], 0, 2)], curOf(S), sameWith([]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"] });
  });
  it("insert -> applied, inserted after P; same is not called", () => {
    const S2 = segsOf("A", "C");
    const log: number[] = [];
    const [d] = decide(S2, [region(S2, "insert", [], 0, 1)], curOf(S2), sameWith([["c:A"]], {}, log));
    expect(d).toMatchObject({ mark: "applied", survivors: [], place: { ref: "A", where: "after" } });
    expect(log).toEqual([]);
  });
});

describe("anchors", () => {
  it("no P and no N (empty base) -> start of document", () => {
    const [d] = decide([], [region([], "insert", [], -1, -1)], { ids: [], types: [] }, sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: null, place: { start: true } });
  });
  it("the segment of P is also in a region -> look forward for the next unchanged segment", () => {
    const S = segsOf("A", "B", "C", "D");
    expect(anchors(S, [region(S, "rewrite", [1], 0, 2), region(S, "rewrite", [2], 1, 3)])).toEqual([
      { P: "A", N: "D" },
      { P: "A", N: "D" },
    ]);
  });
  it("0-line segments are not anchors: 'A, trailing empty paragraph' with one segment added at the end -> the new segment goes before the empty paragraph (P = A)", () => {
    const S = segsOf("A", "~E");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ P: "A", N: null, place: { ref: "A", where: "after" } });
  });
  it("0-line segments are not anchors: 'leading empty paragraph, A' with one segment added first -> inserted before A (the leading empty paragraph stays first)", () => {
    const S = segsOf("~Z", "A");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: "A", place: { ref: "A", where: "before" } });
  });
});

describe("stripStart", () => {
  const S = segsOf("A", "B", "C");
  const types = { A: "numberedListItem", B: "numberedListItem", C: "numberedListItem" };
  it("inserted after a numbered one, the first pre-parsed block is numbered -> true", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(true);
  });
  it("first list item -> false", () => {
    const [d] = decide(S, [region(S, "rewrite", [0], -1, 1)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(false);
  });
  it("inserted after a numbered one, but the first pre-parsed block is not numbered -> false", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["paragraph"] });
    expect(d!.stripStart).toBe(false);
  });
});

describe("performance: the index is built once", () => {
  it("8 000 blocks, 4 000 regions (insert/rewrite/delete interleaved): decide < 500 ms", () => {
    const names = Array.from({ length: 8000 }, (_, i) => `b${i}`);
    const S = segsOf(...names);
    const regions: Region[] = [];
    for (let k = 1; k < 8000; k += 2) {
      const kind = (["rewrite", "delete", "rewrite", "insert"] as const)[(k >> 1) % 4]!;
      regions.push(kind === "insert" ? region(S, "insert", [], k - 1, k + 1 < 8000 ? k + 1 : -1) : region(S, kind, [k], k - 1, k + 1 < 8000 ? k + 1 : -1));
    }
    const cur = curOf(S);
    const t0 = performance.now();
    const ds = decide(S, regions, cur, sameWith([]));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(ds).toHaveLength(regions.length);
  });
});

describe("anchors of deletion regions", () => {
  it("has P -> P after", () => {
    const S = segsOf("A", "B", "C");
    expect(decide(S, [region(S, "delete", [1], 0, 2)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
  it("only N -> N before", () => {
    const S = segsOf("A", "B");
    expect(decide(S, [region(S, "delete", [0], -1, 1)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "B", position: "before" });
  });
  it("no P, no N, preceded by a 0-line segment -> that block, after (a 0-line segment is not P, but can be a neighbour)", () => {
    const S = segsOf("~Z", "B");
    expect(decide(S, [region(S, "delete", [1], 0, -1)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "Z", position: "after" });
  });
  it("everything at top level deleted, no region writes content -> replaceWithEmpty", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "delete", [0, 1], -1, -1)], curOf(S), sameWith([]));
    expect(ds[0]!.anchor).toBe("replaceWithEmpty");
  });
  it("everything at top level deleted, but another region writes content -> deferred (does not become empty)", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [1], 0, -1)], curOf(S), sameWith([["new"]]));
    expect(ds[0]!.mark).toBe("applied");
    expect(ds[1]!.anchor).toBe("deferred");
  });
  it("if that rewrite region is same (not removed) -> its blocks can be neighbours", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [1], 0, -1)], curOf(S), sameWith([["c:A"]]));
    expect(ds[0]!.mark).toBe("same");
    expect(ds[1]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
});
