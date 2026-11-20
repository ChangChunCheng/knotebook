import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { fingerprintsOfGroups } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { decide } from "../../src/transfer/decide.js";
import { applySync, fileSyncRows } from "../../src/transfer/sync-apply.js";
import type { SyncPlan } from "../../src/transfer/sync-plan.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
import { referenceApplySync } from "./fixtures/apply-sync-reference.js";
import { allBlockIds } from "./fixtures/block-ids.js";
import { forkWithClient } from "./fixtures/removal-reference.js";
import { yjsNote } from "./fixtures/yjs-note.js";
import { applyInMemory, docWith, forkOf, makeBaseInMemory, topOf, withEditor } from "./fixtures/transfer-sync.js";

// Wraps yieldToLoop in a counting spy (still calls the original).
vi.mock("../../src/transfer/yield.js", async importOriginal => {
  const m = await importOriginal<typeof import("../../src/transfer/yield.js")>();
  return { ...m, yieldToLoop: vi.fn(m.yieldToLoop) };
});

/**
 * bulk transfer apply. Merging uses in-memory `Y.applyUpdate`.
 * A changed note gets a 409, and `applySync` is only called when current = base.
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const texts = (doc: Y.Doc) => topOf(doc).map(b => b.text);
async function scene(blocks: unknown[], human?: (ed: Parameters<Parameters<typeof withEditor>[2]>[0], ids: string[]) => void) {
  const doc = await docWith(rt, blocks);
  const b = await makeBaseInMemory(rt, doc);
  const live = forkOf(doc);
  if (human) await withEditor(rt, live, ed => human(ed, b.ids));
  return { b, live };
}
const marks = (r: { plan: { decisions: Array<{ kind: string; mark: string }> } }) => r.plan.decisions.map(d => `${d.kind}:${d.mark}`);

describe("mounts once", () => {
  it("applySync mounts the fork only once (planning once more, one after the other, not nested)", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const m0 = rt.mounts;
    await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(rt.mounts - m0).toBe(2); // scratch 1 + fork 1
    expect(rt.inFlight).toBe(0);
  });
});

describe("rewrite", () => {
  it("applied: inserted at the first survivor's position, survivors removed", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(marks(r)).toEqual(["rewrite:applied"]);
    expect(texts(live)).toEqual(["A", "B2", "C"]);
    expect(topOf(live).map(x => x.id)).toEqual(b.ids);
    expect(r.applied.perRegion[0]!.beforeBlocks.map(x => x.id)).toEqual([b.ids[1]]);
    expect(r.applied.perRegion[0]!.afterIds).toEqual([topOf(live)[1]!.id]);
  });
  it("a rewrite region's afterIds carry the kept survivor id (#551)", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(r.applied.perRegion[0]!.afterIds).toEqual([b.ids[1]]);
    expect(r.applied.perRegion[0]!.beforeBlocks.map(x => x.id)).toEqual([b.ids[1]]);
  });
  it("a deferred delete anchor that lands on a kept block is mapped to the kept id (#551)", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const fork = forkOf(live);
    const sv = Y.encodeStateVector(fork);
    const segs = b.base.segments!;
    const region = (kind: "rewrite" | "delete", k: number, prevSeg: number, nextSeg: number) => ({
      kind,
      segIdx: [k],
      baseIds: segs[k]!.ids,
      baseFps: segs[k]!.fps,
      text: kind === "delete" ? "" : "A2",
      prevSeg,
      nextSeg,
    });
    const regions = [region("rewrite", 0, -1, 1), region("delete", 1, 0, -1)];
    const cur = { ids: b.ids, fps: b.fps, types: b.types };
    const decisions = decide(segs, regions, cur, () => false);
    expect(decisions[1]!.anchor).toBe("deferred");
    const plan = { regions, decisions, parsed: [[{ type: "paragraph", content: "A2" }], []], unbound: 0, boundaryChecks: 0 } as unknown as SyncPlan;
    const applied = await applySync(rt, fork, sv, plan, cur);
    Y.applyUpdate(live, applied.diff);
    expect(applied.perRegion[1]!.anchor).toEqual({ block_id: b.ids[0], position: "after" });
    expect(applied.perRegion[0]!.afterIds).toEqual([b.ids[0]]);
    expect(topOf(live).map(x => `${x.id}:${x.text}`)).toEqual([`${b.ids[0]}:A2`]);
  });
  it("1,000 rewrite regions (2,000 paragraphs, every other changed): all ids kept, no duplicates, apply time linear (#551)", async () => {
    const run = async (n: number) => {
      const doc = await docWith(rt, Array.from({ length: n }, (_, i) => P(`p${i}`)));
      const b = await makeBaseInMemory(rt, doc);
      const live = forkOf(doc);
      const body = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
      const t0 = performance.now();
      const r = await applyInMemory(rt, b, body, live, { applyYieldFn: async () => {} });
      const ms = performance.now() - t0;
      const ids = allBlockIds(live);
      expect(r.plan.regions).toHaveLength(n / 2);
      expect(topOf(live).map(x => x.id)).toEqual(b.ids);
      expect(new Set(ids).size).toBe(ids.length);
      return ms;
    };
    await run(100);
    const small = Math.min(await run(250), await run(250));
    const large = await run(2000);
    // 8x the regions: linear is about 8x; quadratic would be about 64x
    expect(large).toBeLessThan(small * 8 * 4 + 2000);
  }, 360_000);
});

describe("deletion-region anchor", () => {
  it("a segment before -> P after", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nC", live);
    expect(texts(live)).toEqual(["A", "C"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[0], position: "after" });
  });
  it("at the start -> N before", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const r = await applyInMemory(rt, b, "B", live);
    expect(texts(live)).toEqual(["B"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[1], position: "before" });
  });
});

describe("defensive checks", () => {
  it("an inserted block that is not top-level -> applySync throws before diffSince (nothing merged)", async () => {
    const doc = await docWith(rt, [{ type: "bulletListItem", content: "a", children: [P("child")] }, P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const fork = forkOf(live);
    const sv = Y.encodeStateVector(fork);
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const planned = await planInMemory(rt, b, "* a\n\nchild\n\nB2", fork);
    if (!planned.ok) throw new Error("plan failed");
    // shape where decision and application disagree: the placement point is replaced with a nested child block (inserting there would land inside the bullet's children)
    const childId = await withEditor(rt, forkOf(fork), ed => (ed.document[0]!.children[0] as { id: string }).id);
    const d = planned.plan.decisions[0]!;
    expect(d.kind).toBe("rewrite");
    d.place = { ref: childId, where: "after" };
    d.survivors = [];
    const before = Y.encodeStateAsUpdate(live);
    await expect(applySync(rt, fork, sv, planned.plan, planned.cur)).rejects.toThrow("不在頂層");
    expect(Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before))).toBe(true);
    expect(rt.inFlight).toBe(0);
  });
});

describe("yielding", () => {
  it("3 regions -> once before mount, once after, plus once between regions", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A2\n\nB\n\nC2\n\nD\n\nE2", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(r.plan.regions).toHaveLength(3);
    expect(yields).toBe(2 + 3);
  });
  it("also once between deletion regions; the replace branch of an empty note yields too", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A\n\nC\n\nE", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(marks(r)).toEqual(["delete:applied", "delete:applied"]);
    expect(yields).toBe(2 + 2);
    const empty = new Y.Doc();
    const be = await makeBaseInMemory(rt, empty);
    let ey = 0;
    await applyInMemory(rt, be, "P1", forkOf(empty), { now: clock(25), applyYieldFn: async () => void ey++ });
    expect(ey).toBe(2 + 1);
  });
  it("without yieldFn -> yieldToLoop is called at least once", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const spy = vi.mocked(yieldToLoop);
    const fork = forkOf(live);
    // measure only applySync: planning runs separately (with a no-op yield injected), then count the calls during applySync
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const sv = Y.encodeStateVector(fork);
    const planned = await planInMemory(rt, b, "A\n\nB2", fork, { yieldFn: async () => {} });
    if (!planned.ok) throw new Error("plan failed");
    spy.mockClear();
    await applySync(rt, fork, sv, planned.plan, planned.cur);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
  it("yields once before mounting the fork and once after: the mounts recorded at the yields are, in order, \"before mount\" and \"after mount\"", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const fork = forkOf(live);
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const sv = Y.encodeStateVector(fork);
    const planned = await planInMemory(rt, b, "A\n\nB2", fork, { yieldFn: async () => {} });
    if (!planned.ok) throw new Error("plan failed");
    const m0 = rt.mounts;
    const seen: number[] = [];
    await applySync(rt, fork, sv, planned.plan, planned.cur, { yieldFn: async () => void seen.push(rt.mounts - m0) });
    expect(seen.slice(0, 2)).toEqual([0, 1]);
  });
});

describe("log rows (the row-count precondition of fileSyncRows)", () => {
  it("same regions are not logged; rewrite rows have anchor null + non-empty after; deletion rows carry the anchor + empty after; fingerprints = the merged afterGroups", async () => {
    const { b, live } = await scene([P("A"), { type: "bulletListItem", content: "item" }, P("B"), P("C"), P("X"), P("D"), P("E")]);
    const r = await applyInMemory(rt, b, "A\n\n- item\n\nB\n\nC2\n\nX\n\nE", live);
    expect(marks(r)).toEqual(["rewrite:same", "rewrite:applied", "delete:applied"]);
    const afterFingerprints = fingerprintsOfGroups(live.getXmlFragment(YDOC_FRAGMENT), r.applied.perRegion.map(p => p.afterIds));
    const { rows, regionIdx } = fileSyncRows({ noteId: "n", userId: "u", tokenId: null, agentLabel: null, decisions: r.plan.decisions, perRegion: r.applied.perRegion, afterFingerprints });
    expect(regionIdx).toEqual([1, 2]);
    expect(rows.map(x => ({ op: x.op, anchor: x.anchor, after: x.afterBlockIds, fp: x.afterFingerprint }))).toEqual([
      { op: "file_sync", anchor: null, after: r.applied.perRegion[1]!.afterIds, fp: afterFingerprints[1] },
      { op: "file_sync", anchor: { block_id: b.ids[4], position: "after" }, after: [], fp: null },
    ]);
    expect(afterFingerprints[1]).not.toBeNull();
  });
});

describe("block removal after the editor is closed (#553)", () => {
  const xmlOf = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT).toString();
  const NOOP = async () => {};
  const idPara = (id: string, text: string) => ({ id, type: "paragraph", content: text });
  const idBullet = (id: string, text: string) => ({ id, type: "bulletListItem", content: text });
  async function baseOf(texts: string[]) {
    const doc = await docWith(rt, texts.map((t, i) => idPara(`b${i}`, t)));
    const b = await makeBaseInMemory(rt, doc);
    return { doc, b, segs: b.base.segments!, cur: { ids: b.ids, fps: b.fps, types: b.types } };
  }
  const regionOf = (segs: NonNullable<Awaited<ReturnType<typeof baseOf>>["segs"]>, kind: "rewrite" | "delete" | "insert", segIdx: number[], prevSeg: number, nextSeg: number, text = "") => ({
    kind,
    segIdx,
    baseIds: segIdx.flatMap(k => segs[k]!.ids),
    baseFps: segIdx.flatMap(k => segs[k]!.fps),
    text,
    prevSeg,
    nextSeg,
  });

  it("rewrite, insert, anchored delete and deferred delete regions together: byte-identical diff, identical XML and perRegion as the old applySync", async () => {
    const { doc, segs, cur } = await baseOf(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    const regions = [
      regionOf(segs, "rewrite", [0], -1, -1, "x0"),
      regionOf(segs, "delete", [1], 0, 2),
      regionOf(segs, "rewrite", [2], -1, -1, "y2"),
      regionOf(segs, "insert", [], 4, 5, "ins"),
      regionOf(segs, "delete", [6], 5, 7),
      regionOf(segs, "rewrite", [8], -1, -1, "z8"),
    ];
    const decisions = decide(segs, regions, cur, () => false);
    // Its neighbours on both sides are rewrite survivors, so the scan has to walk past queued blocks.
    decisions[1]!.anchor = "deferred";
    const parsed = [[idPara("n1", "x0")], [], [idBullet("n2", "y2"), idBullet("n3", "y2b")], [idPara("n4", "ins")], [], [idPara("n5", "z8")]];
    const plan = { regions, decisions, parsed, unbound: 0, boundaryChecks: 0 } as unknown as SyncPlan;
    const state = Y.encodeStateAsUpdate(doc);

    const { fork, sv } = forkWithClient(state, 4242);
    const w = await applySync(rt, fork, sv, plan, cur, { yieldFn: NOOP });
    const r = await referenceApplySync(rt, state, 4242, plan, cur);

    expect(Buffer.from(w.diff).equals(Buffer.from(r.diff))).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));
    expect(w.perRegion).toEqual(r.perRegion);
    // The block the rewrite of b0 inserted, mapped to the kept id.
    expect(w.perRegion[1]!.anchor).toEqual({ block_id: cur.ids[0], position: "after" });
  });

  it("a deferred delete anchor skips rewrite survivors that are queued for removal", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const fork = forkOf(live);
    const sv = Y.encodeStateVector(fork);
    const segs = b.base.segments!;
    const regions = [regionOf(segs, "rewrite", [0], -1, 1, "A2"), regionOf(segs, "delete", [1], 0, -1)];
    const cur = { ids: b.ids, fps: b.fps, types: b.types };
    const decisions = decide(segs, regions, cur, () => false);
    expect(decisions[1]!.anchor).toBe("deferred");
    const plan = { regions, decisions, parsed: [[{ type: "bulletListItem", content: "A2" }], []], unbound: 0, boundaryChecks: 0 } as unknown as SyncPlan;
    const applied = await applySync(rt, fork, sv, plan, cur, { yieldFn: NOOP });
    Y.applyUpdate(live, applied.diff);
    const newId = applied.perRegion[0]!.afterIds[0]!;
    expect(newId).not.toBe(b.ids[0]);
    expect(applied.perRegion[1]!.anchor).toEqual({ block_id: newId, position: "after" });
    expect(topOf(live).map(x => x.id)).toEqual([newId]);
  });

  it("deleting every top-level block leaves one empty paragraph; each region anchors on it as a placeholder, the first before, the rest after", async () => {
    const { doc, segs, cur } = await baseOf(["t0", "t1", "t2", "t3"]);
    const regions = [regionOf(segs, "delete", [0, 1], -1, -1), regionOf(segs, "delete", [2, 3], -1, -1)];
    const decisions = decide(segs, regions, cur, () => false);
    expect(decisions.map(d => d.anchor)).toEqual(["replaceWithEmpty", "replaceWithEmpty"]);
    const plan = { regions, decisions, parsed: [[], []], unbound: 0, boundaryChecks: 0 } as unknown as SyncPlan;
    const live = forkOf(doc);
    const fork = forkOf(live);
    const applied = await applySync(rt, fork, Y.encodeStateVector(fork), plan, cur, { yieldFn: NOOP });
    Y.applyUpdate(live, applied.diff);
    const top = topOf(live);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ type: "paragraph", text: "" });
    expect(applied.perRegion.map(p => p.anchor)).toEqual([
      { block_id: top[0]!.id, position: "before", placeholder: true },
      { block_id: top[0]!.id, position: "after", placeholder: true },
    ]);
  });

  it("one delete region of 3,999 of 4,000 paragraphs costs little more than mounting the note", async () => {
    const n = 4_000;
    const state = Y.encodeStateAsUpdate(yjsNote(n));
    const ids = Array.from({ length: n }, (_, i) => `q${i}`);
    const survivors = ids.slice(1);
    const region = { kind: "delete", segIdx: [], baseIds: survivors, baseFps: [], text: "", prevSeg: -1, nextSeg: -1 };
    const decision = { kind: "delete", mark: "applied", survivors, place: { replaceSurvivors: true }, stripStart: false, P: ids[0], N: null, anchor: { block_id: ids[0]!, position: "after" } };
    const plan = { regions: [region], decisions: [decision], parsed: [[]], unbound: 0, boundaryChecks: 0 } as unknown as SyncPlan;
    const cur = { ids };
    const timeApply = async () => {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, state);
      const sv = Y.encodeStateVector(fork);
      const t0 = performance.now();
      const applied = await applySync(rt, fork, sv, plan, cur, { yieldFn: NOOP });
      const ms = performance.now() - t0;
      expect(applied.perRegion[0]!.beforeBlocks).toHaveLength(n - 1);
      expect(topOf(fork).map(x => x.id)).toEqual(["q0"]);
      return ms;
    };
    const timeMount = async () => {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, state);
      const t0 = performance.now();
      const s = await EditorSession.open(rt, fork);
      s.close();
      return performance.now() - t0;
    };
    const apply: number[] = [];
    const mount: number[] = [];
    for (let i = 0; i < 3; i++) {
      apply.push(await timeApply());
      mount.push(await timeMount());
    }
    const minApply = Math.min(...apply);
    const minMount = Math.min(...mount);
    console.log(`[perf] #553 applySync delete 3,999/4,000: apply ${minApply.toFixed(0)} ms, mount ${minMount.toFixed(0)} ms`);
    expect(minApply).toBeLessThanOrEqual(1.5 * minMount + 200);
  }, 120_000);
});

describe("empty note", () => {
  it("a fork with zero top-level blocks + the agent writes two paragraphs -> the result is exactly two blocks (no extra empty paragraph), log rows are insertion rows", async () => {
    const empty = new Y.Doc();
    const b = await makeBaseInMemory(rt, empty);
    expect(b.base.segments).toEqual([]);
    const live = forkOf(empty);
    const r = await applyInMemory(rt, b, "P1\n\nP2", live);
    expect(marks(r)).toEqual(["insert:applied"]);
    expect(texts(live)).toEqual(["P1", "P2"]);
    expect(r.applied.perRegion[0]).toMatchObject({ beforeBlocks: [], anchor: null });
    expect(r.applied.perRegion[0]!.afterIds).toEqual(topOf(live).map(x => x.id));
  });
});
