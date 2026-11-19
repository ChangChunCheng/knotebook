import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { fingerprintsOfGroups } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { fileSyncRows } from "../../src/transfer/sync-apply.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
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
    expect(topOf(live).map(x => x.id)).not.toContain(b.ids[1]);
    expect(r.applied.perRegion[0]!.beforeBlocks.map(x => x.id)).toEqual([b.ids[1]]);
    expect(r.applied.perRegion[0]!.afterIds).toEqual([topOf(live)[1]!.id]);
  });
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
