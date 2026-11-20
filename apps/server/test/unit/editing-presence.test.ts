import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import {
  PresenceRegistry, presenceClientId, presenceTargetForRead, presenceTargetForWrite,
} from "../../src/notes/editing/presence.js";

/** Implements only the surface the registry really uses: documents.get(name) -> { awareness:{states,meta,emit}, getXmlFragment }. */
function fakeHocuspocus() {
  const documents = new Map<string, ReturnType<typeof makeDoc>>();
  function makeDoc() {
    const states = new Map<number, unknown>();
    const meta = new Map<number, { clock: number; lastUpdated: number }>();
    const emitted: unknown[][] = [];
    return {
      awareness: { states, meta, emit: (name: string, args: unknown[]) => { emitted.push([name, ...args]); } },
      emitted,
      // Empty fragment: cursorFor finds no text node -> no cursor is sent. This file only checks the registry's mechanics; where the cursor
      // lands is checked on a real Yjs structure in test/note-presence.test.ts.
      getXmlFragment: () => ({ get: () => undefined, length: 0 }),
    };
  }
  return { documents, makeDoc };
}
const user = { name: "w (claude)", color: "#7c3aed", handle: "w", label: "claude" };
type FakeDoc = ReturnType<ReturnType<typeof fakeHocuspocus>["makeDoc"]>;
const clockOf = (doc: FakeDoc, id: number) => doc.awareness.meta.get(id)!.clock;

describe("PresenceRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clientId is a uint32 and stable for (noteId, tokenId); capacity defaults to 500", () => {
    const a = presenceClientId("n1", "t1");
    expect(a).toBe(presenceClientId("n1", "t1"));
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
    expect(a).not.toBe(presenceClientId("n1", "t2"));
    expect(a).not.toBe(presenceClientId("n2", "t1"));
    expect(new PresenceRegistry(undefined).capacity).toBe(500);
  });

  it("target derivation: three read forms; writes use the afterBlockIds from after the edit (replace_all -> document start, delete_section -> document start, others -> the first block just written)", () => {
    expect(presenceTargetForRead(undefined)).toEqual({ kind: "doc-start" });
    expect(presenceTargetForRead("_top")).toEqual({ kind: "section", sectionId: "_top" });
    expect(presenceTargetForRead("sec-1")).toEqual({ kind: "section", sectionId: "sec-1" });
    // The second argument is `ApplyResult.afterBlockIds`, the ids of blocks newly written by the edit (document order), not the request's
    // section_id: that is the heading's block id, and replace_section/delete_section replace the heading too, so it no longer exists after the edit.
    expect(presenceTargetForWrite("replace_all", ["r1", "r2"])).toEqual({ kind: "doc-start" });
    expect(presenceTargetForWrite("replace_section", ["s1", "s2"])).toEqual({ kind: "block", blockId: "s1" });
    expect(presenceTargetForWrite("insert_after", ["i1"])).toEqual({ kind: "block", blockId: "i1" });
    expect(presenceTargetForWrite("append", ["p1", "p2"])).toEqual({ kind: "block", blockId: "p1" });
    // delete_section's afterIds are always empty (the delete branch of `prepareEdit` never assigns afterIds): the deleted section no longer
    // exists, so it explicitly goes to the document start.
    expect(presenceTargetForWrite("delete_section", [])).toEqual({ kind: "doc-start" });
    // Defensive: any op given an empty array falls back to the document start, never passing undefined into blockId
    expect(presenceTargetForWrite("append", [])).toEqual({ kind: "doc-start" });
  });

  it("touch: seeds only when the document is loaded (states+meta+emit added); clock starts at 1; not loaded is a no-op; with no hocuspocus everything is a no-op", () => {
    // The clock map is process-wide; the key pair (n2, t2) is only touched in this case, so "starts at 1" can be asserted as an absolute value
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n2", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n2", "t2");
    reg.touch("n2", "t2", user, { kind: "doc-start" });
    expect(doc.awareness.states.get(id)).toMatchObject({ user: { name: user.name, color: user.color } });
    expect(clockOf(doc, id)).toBe(1);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [id], updated: [], removed: [] }, "ai-presence"]);
    reg.touch("nx", "t2", user, { kind: "doc-start" });
    expect(reg.size).toBe(1);
    const none = new PresenceRegistry(undefined);
    none.touch("n2", "t2", user, { kind: "doc-start" });
    expect(none.size).toBe(0);
  });

  it("heartbeat every 10 s: clock+1, emit updated; documents.get is re-fetched every beat (after unload the old object is not touched)", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n3", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n3", "t3");
    reg.touch("n3", "t3", user, { kind: "doc-start" });
    const c0 = clockOf(doc, id);
    vi.advanceTimersByTime(10_000);
    expect(clockOf(doc, id)).toBe(c0 + 1);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [], updated: [id], removed: [] }, "ai-presence"]);
    const c1 = clockOf(doc, id);
    h.documents.delete("n3"); const fresh = h.makeDoc(); h.documents.set("n3", fresh);
    vi.advanceTimersByTime(10_000);
    expect(clockOf(doc, id)).toBe(c1);
    expect(clockOf(fresh, id)).toBe(c1 + 1);
  });

  it("idle 120 s -> stop (states.delete, clock+1, emit removed); after stop a re-touch continues the clock (no reset)", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n4", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n4", "t4");
    reg.touch("n4", "t4", user, { kind: "doc-start" });
    vi.advanceTimersByTime(120_000);
    expect(doc.awareness.states.has(id)).toBe(false);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [], updated: [], removed: [id] }, "ai-presence"]);
    const afterStop = clockOf(doc, id);
    reg.touch("n4", "t4", user, { kind: "doc-start" });
    expect(clockOf(doc, id)).toBe(afterStop + 1);
    expect(reg.size).toBe(1);
  });

  it("the (capacity+1)th entry evicts the entry with the oldest heartbeat (state cleared, timer cleared); stopAll clears everything", () => {
    const h = fakeHocuspocus();
    const reg = new PresenceRegistry(h as never, { capacity: 2 });
    for (const n of ["a5", "b5", "c5"]) {
      h.documents.set(n, h.makeDoc());
      reg.touch(n, "t5", user, { kind: "doc-start" });
      vi.advanceTimersByTime(1);
    }
    expect(reg.size).toBe(2);
    expect(h.documents.get("a5")!.awareness.states.size).toBe(0);
    reg.stopAll();
    expect(reg.size).toBe(0);
    const before = h.documents.get("b5")!.emitted.length;
    vi.advanceTimersByTime(60_000);
    expect(h.documents.get("b5")!.emitted.length).toBe(before);
  });

  it("the state sent on every touch/heartbeat is deep-unequal to the previous one (beat increases monotonically), so the name tag lights up", () => {
    // Awareness emits its change event only when !equalityDeep(state, prevState) (y-protocols/awareness.js), and BlockNote's data-active
    // handler only consumes the `updated` of the change (@blocknote/core/dist/yjs.js). Remove `beat` from the state -> a heartbeat sends a
    // state identical to the previous one -> no change event -> the name tag stays a transparent 4x5 box. This case catches that.
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n7", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n7", "t7");
    const snap = () => JSON.stringify(doc.awareness.states.get(id));
    reg.touch("n7", "t7", user, { kind: "doc-start" });
    const s1 = snap();
    vi.advanceTimersByTime(10_000);
    const s2 = snap();
    // heartbeat: target and content unchanged, so only `beat` can make s2 differ from s1
    expect(s2).not.toBe(s1);
    reg.touch("n7", "t7", user, { kind: "doc-start" });
    const s3 = snap();
    expect(s3).not.toBe(s2);
    const beats = [s1, s2, s3].map(s => (JSON.parse(s) as { beat: number }).beat);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    expect(new Set(beats).size).toBe(3);
  });

  it("when the first child of the content is an element rather than text (tables etc.) no cursor is sent and nothing throws (narrowing to only check undefined would miss this case, see the type-check note in presence.ts)", () => {
    // Hand-built: blockContainer(tbl1) > table > tableRow (the table's content is not XmlText but another XmlElement). Content with no children
    // at all (image/divider) is the simpler case; this case targets the narrow gap "has a child, but an
    // element, not text", which narrowing most easily misses.
    const yDoc = new Y.Doc();
    const fragment = yDoc.getXmlFragment(YDOC_FRAGMENT);
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", "tbl1");
    const table = new Y.XmlElement("table");
    const row = new Y.XmlElement("tableRow");
    table.insert(0, [row]);
    container.insert(0, [table]);
    group.insert(0, [container]);
    fragment.insert(0, [group]);
    const states = new Map<number, unknown>();
    const meta = new Map<number, { clock: number; lastUpdated: number }>();
    const h = {
      documents: new Map([["n9", {
        awareness: { states, meta, emit: () => {} },
        getXmlFragment: yDoc.getXmlFragment.bind(yDoc),
      }]]),
    };
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n9", "t9");
    expect(() => reg.touch("n9", "t9", user, { kind: "block", blockId: "tbl1" })).not.toThrow();
    expect(states.get(id)).not.toHaveProperty("cursor");
  });

  it("malformed row: a column's first child is XmlText (malformed Y a client can send) -> no throw, no cursor", () => {
    const yDoc = new Y.Doc();
    const fragment = yDoc.getXmlFragment(YDOC_FRAGMENT);
    const group = new Y.XmlElement("blockGroup");
    const list = new Y.XmlElement("columnList");
    list.setAttribute("id", "row1");
    const col = new Y.XmlElement("column");
    col.insert(0, [new Y.XmlText()]);
    list.insert(0, [col]);
    group.insert(0, [list]);
    fragment.insert(0, [group]);
    const states = new Map<number, unknown>();
    const meta = new Map<number, { clock: number; lastUpdated: number }>();
    const h = { documents: new Map([["n8", { awareness: { states, meta, emit: () => {} }, getXmlFragment: yDoc.getXmlFragment.bind(yDoc) }]]) };
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n8", "t8");
    expect(() => reg.touch("n8", "t8", user, { kind: "block", blockId: "row1" })).not.toThrow();
    expect(states.get(id)).not.toHaveProperty("cursor");
    reg.stopAll();
  });

  it("the clock map lives for the process: a brand-new registry still gives the same key a strictly increasing clock", () => {
    // The invariant is that the clock map must not move into the instance (named in the header of presence.ts): moving the map into the
    // instance, or adding a reset(), is caught here.
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n6", doc);
    const id = presenceClientId("n6", "t6");
    const first = new PresenceRegistry(h as never);
    first.touch("n6", "t6", user, { kind: "doc-start" });
    first.stop("n6", "t6");
    const highWater = clockOf(doc, id);
    const second = new PresenceRegistry(h as never);
    second.touch("n6", "t6", user, { kind: "doc-start" });
    expect(clockOf(doc, id)).toBeGreaterThan(highWater);
  });

  it("state carries the `knotebook` agent marker; `user` has exactly the name/color fields (handle/label don't leak into user)", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("nk1", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("nk1", "tk1");
    reg.touch("nk1", "tk1", user, { kind: "doc-start" });
    const st = doc.awareness.states.get(id) as { user: unknown; knotebook: unknown };
    expect(st.knotebook).toEqual({ v: 1, kind: "agent", handle: "w", label: "claude" });
    expect(st.user).toEqual({ name: "w (claude)", color: "#7c3aed" });
  });

  it("touching the same (note, token) again with a different identity -> the state follows; after a heartbeat it is still the new value", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("nk2", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("nk2", "tk2");
    reg.touch("nk2", "tk2", user, { kind: "doc-start" });
    reg.touch("nk2", "tk2", { ...user, label: "codex", name: "w (codex)" }, { kind: "doc-start" });
    const st = () => doc.awareness.states.get(id) as { user: { name: string }; knotebook: { label: string } };
    expect(st().knotebook.label).toBe("codex");
    expect(st().user.name).toBe("w (codex)");
    vi.advanceTimersByTime(10_000);
    expect(st().knotebook.label).toBe("codex");
    expect(st().user.name).toBe("w (codex)");
  });
});
