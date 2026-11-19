import { describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import * as shared from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { sameCanonicalStats } from "../../src/transfer/same-canonical.js";
// Cases that count calls do not measure wall-clock time but still really yield to the event loop: running the whole planning (thousands of regions) synchronously would hold the vitest worker (onTaskUpdate 60 s timeout, CI of PR #400).
import { yieldToLoop } from "../../src/transfer/yield.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory, withEditor } from "./fixtures/transfer-sync.js";

// Guard that does not depend on time: count how many times `topLevelContainers` is called (the same top-level index entry as sameCanonical; wrapped in a counter that still calls the original).
vi.mock("@knotebook/shared", async importOriginal => {
  const m = await importOriginal<typeof import("@knotebook/shared")>();
  return { ...m, topLevelContainers: vi.fn(m.topLevelContainers) };
});

/**
 * bulk transfer: complexity and stalls in the tail of planning. With 2 000 blocks and every other block changed (1 000 regions), rebuilding the top-level table per region
 * is O(regions x top-level count) (7 639 ms synchronously after the last yield, of which 1 000 sameCanonicalSeq calls took 6 158 ms).
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });

async function scene(n: number) {
  const doc = await docWith(rt, Array.from({ length: n }, (_, i) => P(`p${i}`)));
  const b = await makeBaseInMemory(rt, doc);
  const body = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
  return { b, live: forkOf(doc), body };
}

describe("tail of planning", () => {
  // The wall-clock threshold only catches order-of-magnitude regressions (300 ms can flip either way on a cloud CI); the stepping-clock case in
  // transfer-sync-plan.test.ts checks "yield after every region" deterministically, and the cases below count calls.
  it("1 000 regions, 2 000 blocks: with the default yield, the longest synchronous interval (including from the last yield to the return) < 1 500 ms", async () => {
    const { b, live, body } = await scene(2000);
    const stamps: number[] = [];
    const { yieldToLoop } = await import("../../src/transfer/yield.js");
    const t0 = performance.now();
    const r = await planInMemory(rt, b, body, live, {
      yieldFn: async () => {
        stamps.push(performance.now());
        await yieldToLoop();
        stamps.push(performance.now());
      },
    });
    const t1 = performance.now();
    if (!r.ok) throw new Error(r.code);
    expect(r.plan.regions).toHaveLength(1000);
    // interval = from returning from one yield to the start of the next; the head (start to the first yield) and the tail (return from the last yield to the end) count too
    const points = [t0, ...stamps, t1];
    let maxGap = 0;
    for (let i = 0; i + 1 < points.length; i += 2) maxGap = Math.max(maxGap, points[i + 1]! - points[i]!);
    const tail = t1 - stamps[stamps.length - 1]!;
    console.log(`PERF regions=1000 blocks=2000 total=${(t1 - t0).toFixed(0)}ms yields=${stamps.length / 2} maxGap=${maxGap.toFixed(0)}ms tail=${tail.toFixed(0)}ms`);
    expect(tail).toBeLessThan(1500);
    expect(maxGap).toBeLessThan(1500);
  }, 180_000);

  it("the number of topLevelContainers calls does not depend on the number of regions (the index is built once per fragment)", async () => {
    const spy = vi.mocked(shared.topLevelContainers);
    const counts: number[] = [];
    for (const n of [20, 200]) {
      const { b, live, body } = await scene(n);
      spy.mockClear();
      const r = await planInMemory(rt, b, body, live, { yieldFn: yieldToLoop });
      if (!r.ok) throw new Error(r.code);
      counts.push(spy.mock.calls.length);
    }
    console.log(`TOPLEVEL calls: 10 regions=${counts[0]} / 100 regions=${counts[1]}`);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(4);
  }, 120_000);

  it("scratch writes do not re-read editor.document per region (the whole block JSON; call count independent of the number of regions)", async () => {
    const spy = vi.spyOn(BlockNoteEditor.prototype, "document", "get");
    const counts: number[] = [];
    try {
      for (const n of [20, 200]) {
        const { b, live, body } = await scene(n);
        spy.mockClear();
        const r = await planInMemory(rt, b, body, live, { yieldFn: yieldToLoop });
        if (!r.ok) throw new Error(r.code);
        counts.push(spy.mock.calls.length);
      }
    } finally {
      spy.mockRestore();
    }
    console.log(`DOCUMENT getter: 10 regions=${counts[0]} / 100 regions=${counts[1]}`);
    expect(counts[1]).toBe(counts[0]);
  }, 120_000);

  /** A human deletes the whole base and replaces it with 2 000 foreign blocks; the agent inserts a paragraph at 1 000 places (insertion regions, compared contiguously with the foreign blocks) or changes 1 000 paragraphs (rewrite regions, survivors all gone, equal). */
  async function foreignScene(mode: "insert" | "rewrite") {
    const n = 1000;
    const doc = await docWith(rt, Array.from({ length: n }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    await withEditor(rt, live, ed => ed.replaceBlocks(ed.document.map(x => x.id), Array.from({ length: 2000 }, (_, i) => P(`foreign${i}`)) as never));
    const body = Array.from({ length: n }, (_, i) => (mode === "insert" ? `p${i}\n\nnew${i}` : i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    return { b, live, body };
  }
  it("canonicalize count (not wall-clock): 1 000 insertion regions x 2 000 foreign blocks -> at most once per foreign block (cache); rewrite regions of different length -> foreign blocks are not canonicalized (length compared first)", async () => {
    const ins = await foreignScene("insert");
    sameCanonicalStats.canonicalized = 0;
    const ri = await planInMemory(rt, ins.b, ins.body, ins.live, { yieldFn: yieldToLoop });
    if (!ri.ok) throw new Error(ri.code);
    expect(ri.plan.regions.filter(r => r.kind === "insert")).toHaveLength(1000);
    const insCount = sameCanonicalStats.canonicalized;
    const rw = await foreignScene("rewrite");
    sameCanonicalStats.canonicalized = 0;
    const rr = await planInMemory(rt, rw.b, rw.body, rw.live, { yieldFn: yieldToLoop });
    if (!rr.ok) throw new Error(rr.code);
    expect(rr.plan.regions).toHaveLength(500);
    const rwCount = sameCanonicalStats.canonicalized;
    console.log(`CANON insert=${insCount} rewrite=${rwCount}`);
    expect(insCount).toBeLessThanOrEqual(1000 + 2000); // pre-parse 1 000 + foreign 2 000, once each
    expect(rwCount).toBeLessThanOrEqual(500); // pre-parse only; no foreign block is canonicalized
  }, 300_000);
});
