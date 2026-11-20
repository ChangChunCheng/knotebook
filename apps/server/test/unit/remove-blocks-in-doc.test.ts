/**
 * #553: removing the old blocks of a rewrite at the Yjs layer after the editor is closed. The merged update must equal the one the editor-level removal
 * produced (byte for byte where each editor call removed one contiguous run), and the cost must grow with the blocks removed, not with blocks x note size.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import {
  EditorSession,
  forkFrom,
  pickBlocks,
  removeBlocksInDoc,
  topLevelBlocksById,
  withForkEditor,
  type AnyEditor,
  type AnyPartialBlock,
  type ForkEdits,
} from "../../src/notes/editing/session.js";
import { applySync } from "../../src/transfer/sync-apply.js";
import { expectLinear, timeIt, yieldToLoop } from "../perf-helpers.js";
import { referenceApplySync } from "./fixtures/apply-sync-reference.js";
import { allBlockIds, topIds, totalClock } from "./fixtures/block-ids.js";
import { forkWithClient, referenceWrite } from "./fixtures/removal-reference.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory } from "./fixtures/transfer-sync.js";
import { yjsNote, type YjsBlockSpec } from "./fixtures/yjs-note.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const H = (id: string, t: string): AnyPartialBlock => ({ id, type: "heading", props: { level: 1 }, content: t });
const P = (id: string, t: string): AnyPartialBlock => ({ id, type: "paragraph", content: t });
const xmlOf = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

async function docOf(blocks: AnyPartialBlock[]): Promise<Y.Doc> {
  await yieldToLoop();
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}

const baseBlocks = (): AnyPartialBlock[] => [H("hA", "A"), P("a1", "a1 text"), P("a2", "a2 text"), H("hB", "B"), P("b1", "b1 text"), P("b2", "b2 text"), H("hC", "C"), P("c1", "c1 text")];
const BASE_IDS = ["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"];
const stateOf = (doc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(doc);
const baseClients = (state: Uint8Array): number[] => [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).keys()];

/** A copy of `state` with `diff` applied; mounting an editor on it must not write anything back. */
async function applied(state: Uint8Array, diff: Uint8Array): Promise<Y.Doc> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, state);
  Y.applyUpdate(copy, diff);
  const clock = totalClock(copy);
  const s = await EditorSession.open(rt, copy);
  s.close();
  expect(totalClock(copy)).toBe(clock);
  return copy;
}

describe("removeBlocksInDoc (#553)", () => {
  it("removes the first top-level block with each id, in one transaction, adding no struct", () => {
    const doc = yjsNote(4, i => ({ id: ["a", "b", "c", "b"][i]!, type: "p", text: `t${i}` }));
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    const clock = totalClock(doc);
    removeBlocksInDoc(doc, ["b"]);
    expect(topIds(doc)).toEqual(["a", "c", "b"]);
    expect(xmlOf(doc)).toContain("t3");
    expect(xmlOf(doc)).not.toContain("t1");
    expect(transactions).toBe(1);
    expect(totalClock(doc)).toBe(clock);
  });

  it("throws and changes nothing for an id that isn't at the top level (missing, or nested in a list item)", async () => {
    const doc = await docOf([P("p1", "x"), { id: "p2", type: "bulletListItem", content: "y", children: [{ id: "c1", type: "bulletListItem", content: "z" }] }]);
    const before = xmlOf(doc);
    expect(() => removeBlocksInDoc(doc, ["missing"])).toThrow();
    expect(() => removeBlocksInDoc(doc, ["c1"])).toThrow();
    expect(() => removeBlocksInDoc(doc, ["p1", "c1"])).toThrow();
    expect(xmlOf(doc)).toBe(before);
    expect(topIds(doc)).toEqual(["p1", "p2"]);
  });

  it("throws and changes nothing when no top-level block would remain", () => {
    const doc = yjsNote(2);
    const before = xmlOf(doc);
    expect(() => removeBlocksInDoc(doc, ["q0", "q1"])).toThrow();
    expect(xmlOf(doc)).toBe(before);
  });

  it("restores doc.gc afterwards, also after throwing", () => {
    const doc = yjsNote(3);
    const during: boolean[] = [];
    doc.on("beforeTransaction", () => during.push(doc.gc));
    expect(doc.gc).toBe(true);
    removeBlocksInDoc(doc, ["q0"]);
    expect(during).toEqual([false]);
    expect(doc.gc).toBe(true);
    expect(() => removeBlocksInDoc(doc, ["nope"])).toThrow();
    expect(doc.gc).toBe(true);
    expect(() => removeBlocksInDoc(doc, ["q1", "q2"])).toThrow();
    expect(doc.gc).toBe(true);
  });

  it("yjsNote matches the editor: mounting an editor on a note of headings (levels 1-3) and paragraphs adds no struct and reads the same blocks", async () => {
    const spec = (i: number): YjsBlockSpec => (i % 2 ? { id: `q${i}`, type: "p", text: `t${i}` } : { id: `q${i}`, type: "h", text: `t${i}`, level: (1 + ((i / 2) % 3)) as 1 | 2 | 3 });
    const doc = yjsNote(6, spec);
    const clock = totalClock(doc);
    const s = await EditorSession.open(rt, doc);
    try {
      const shown = s.editor.document.map(b => ({ id: b.id, type: b.type, level: (b.props as { level?: number }).level, text: (b.content as Array<{ text: string }>).map(c => c.text).join("") }));
      expect(shown).toEqual([
        { id: "q0", type: "heading", level: 1, text: "t0" },
        { id: "q1", type: "paragraph", level: undefined, text: "t1" },
        { id: "q2", type: "heading", level: 2, text: "t2" },
        { id: "q3", type: "paragraph", level: undefined, text: "t3" },
        { id: "q4", type: "heading", level: 3, text: "t4" },
        { id: "q5", type: "paragraph", level: undefined, text: "t5" },
      ]);
    } finally {
      s.close();
    }
    expect(totalClock(doc)).toBe(clock);
    const viaEditor = await docOf(Array.from({ length: 6 }, (_, i) => (i % 2 ? P(`q${i}`, `t${i}`) : { id: `q${i}`, type: "heading", props: { level: 1 + ((i / 2) % 3) }, content: `t${i}` })));
    expect(xmlOf(doc)).toBe(xmlOf(viaEditor));
  });

  it("removing every other block of 4,000/32,000 is linear", async () => {
    await expectLinear(
      "#553 removeBlocksInDoc",
      async n => {
        const doc = yjsNote(n);
        const ids = Array.from({ length: n / 2 }, (_, i) => `q${2 * i}`);
        await yieldToLoop();
        const t = performance.now();
        removeBlocksInDoc(doc, ids);
        const ms = performance.now() - t;
        expect(topIds(doc)).toHaveLength(n / 2);
        return ms;
      },
      32_000,
      { maxMs: 5_000 }
    );
  }, 120_000);
});

type WriteCase = [name: string, base: () => AnyPartialBlock[], write: (e: ForkEdits, ed: AnyEditor) => void, ref: (ed: AnyEditor) => void];

const COL = (id: string, children: AnyPartialBlock[]): AnyPartialBlock => ({ id, type: "column", props: { width: 1 }, children });
const nestedBase = (): AnyPartialBlock[] => [
  P("p1", "before"),
  { id: "li", type: "bulletListItem", content: "list", children: [{ id: "li2", type: "bulletListItem", content: "child" }] },
  { id: "row", type: "columnList", children: [COL("c0", [P("ca", "left")]), COL("c1", [P("cb", "right")])] },
  P("p2", "after"),
];
const newB = (): AnyPartialBlock[] => [H("n1", "B"), P("n2", "x"), P("n3", "y")];

describe("withForkEditor and ForkEdits: same document and same update as removing through the editor (#553)", () => {
  it.each<WriteCase>([
    ["middle section replaced", baseBlocks, e => void e.replace(["hB", "b1", "b2"], newB()), ed => {
      ed.insertBlocks(newB(), "b2", "after");
      ed.removeBlocks(["hB", "b1", "b2"]);
    }],
    ["first section replaced", baseBlocks, e => void e.replace(["hA", "a1", "a2"], newB()), ed => {
      ed.insertBlocks(newB(), "a2", "after");
      ed.removeBlocks(["hA", "a1", "a2"]);
    }],
    ["last section replaced", baseBlocks, e => void e.replace(["hC", "c1"], newB()), ed => {
      ed.insertBlocks(newB(), "c1", "after");
      ed.removeBlocks(["hC", "c1"]);
    }],
    ["whole note replaced", baseBlocks, e => void e.replace(BASE_IDS, newB()), ed => {
      ed.insertBlocks(newB(), "c1", "after");
      ed.removeBlocks(BASE_IDS);
    }],
    [
      "two bulk-style regions inserted before their survivors plus a delete region (one editor call per region)",
      baseBlocks,
      (e, ed) => {
        ed.insertBlocks([P("n1", "r1a"), P("n2", "r1b")], "a1", "before");
        e.remove(["a1"]);
        ed.insertBlocks([P("n3", "r2")], "b1", "before");
        e.remove(["b1"]);
        e.remove(["c1"]);
      },
      ed => {
        ed.insertBlocks([P("n1", "r1a"), P("n2", "r1b")], "a1", "before");
        ed.removeBlocks(["a1"]);
        ed.insertBlocks([P("n3", "r2")], "b1", "before");
        ed.removeBlocks(["b1"]);
        ed.removeBlocks(["c1"]);
      },
    ],
    ["a column list and a nested list replaced", nestedBase, e => void e.replace(["li", "row"], [P("n1", "one"), P("n2", "two")]), ed => {
      ed.insertBlocks([P("n1", "one"), P("n2", "two")], "row", "after");
      ed.removeBlocks(["li", "row"]);
    }],
    ["a section removed with nothing inserted (replaceBlocks(ids, []) in the reference)", baseBlocks, e => void e.replace(["hB", "b1", "b2"], []), ed => {
      ed.replaceBlocks(["hB", "b1", "b2"], []);
    }],
  ])("%s: byte-identical diff and identical XML", async (_n, base, write, ref) => {
    const state = stateOf(await docOf(base()));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (ed, e) => write(e, ed));
    const r = await referenceWrite(rt, state, 4242, ed => {
      ref(ed);
    });
    expect(sameBytes(w.diff, r.diff)).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));
    const copy = await applied(state, w.diff);
    expect(xmlOf(copy)).toBe(xmlOf(r.doc));
  });

  it("non-adjacent blocks in one call: identical XML, and the update only deletes", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const { fork, sv } = forkWithClient(state, 4242);
    const ids = ["a1", "hB", "b2", "c1"];
    const w = await withForkEditor(rt, fork, sv, (_ed, e) => e.remove(ids));
    const r = await referenceWrite(rt, state, 4242, ed => {
      ed.removeBlocks(ids);
    });
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));
    expect(Y.decodeUpdate(w.diff).structs).toHaveLength(0);
    expect(topIds(fork)).toEqual(["hA", "a2", "b1", "hC"]);
  });

  it("removing every top-level block first inserts one empty paragraph, which remove() returns; replace(all, []) leaves the same as the editor did", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const r = await referenceWrite(rt, state, 4242, ed => {
      ed.removeBlocks(BASE_IDS);
    });
    const masked = (doc: Y.Doc) => xmlOf(doc).replace(/id="[^"]*"/g, 'id="X"');
    expect(topIds(r.doc)).toHaveLength(1);

    const a = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, a.fork, a.sv, (_ed, e) => e.remove(BASE_IDS));
    expect(w.value).not.toBeNull();
    expect(topIds(a.fork)).toEqual([w.value!.id]);
    expect(masked(a.fork)).toBe(masked(r.doc));

    const b = forkWithClient(state, 4242);
    await withForkEditor(rt, b.fork, b.sv, (_ed, e) => e.replace(BASE_IDS, []));
    expect(topIds(b.fork)).toHaveLength(1);
    expect(masked(b.fork)).toBe(masked(r.doc));
  });

  it("a never-written note: replacing the normalized paragraph leaves exactly the new blocks", async () => {
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (ed, e) => e.replace(ed.document.map(b => b.id), [P("n1", "hello")]));
    expect(topIds(fork)).toEqual(["n1"]);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, state);
    Y.applyUpdate(copy, w.diff);
    expect(topIds(copy)).toEqual(["n1"]);
  });

  it("renames run after removal, so every kept-id pair applies", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (_ed, e) => {
      const ins = e.replace(["hB", "b1", "b2"], [{ type: "heading", props: { level: 1 }, content: "B" }, { type: "paragraph", content: "b1 text" }, { type: "paragraph", content: "AI-NEW" }]);
      e.rename(new Map(ins.map((b, k) => [b.id, ["hB", "b1", "b2"][k]!] as const)));
    });
    expect(w.renamed.size).toBe(3);
    expect(topIds(fork)).toEqual(BASE_IDS);
    expect(xmlOf(fork)).toContain("AI-NEW");
    expect(new Set(allBlockIds(fork)).size).toBe(allBlockIds(fork).length);
  });

  // The editor-level removal goes through y-prosemirror's content diff, which keeps an old block that equals its reinserted copy and drops the copy; removal at the Yjs layer always deletes the old block. The result reads the same, only the delete set differs.
  it("a reinserted copy that carries a removed block's id and equals it replaces the old block: same document, different delete set", async () => {
    const state = stateOf(await docOf([H("hA", "A"), P("a1", "a1 text")]));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (_ed, e) => void e.replace(["hA", "a1"], [H("hA", "A"), P("a1", "a1 old")]));
    const r = await referenceWrite(rt, state, 4242, ed => {
      ed.insertBlocks([H("hA", "A"), P("a1", "a1 old")], "a1", "after");
      ed.removeBlocks(["hA", "a1"]);
    });
    expect(topIds(fork)).toEqual(["hA", "a1"]);
    expect(xmlOf(fork)).toContain("a1 old");
    expect(xmlOf(fork)).not.toContain("a1 text");
    expect(new Set(allBlockIds(fork)).size).toBe(allBlockIds(fork).length);
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));

    const dw = Y.decodeUpdate(w.diff);
    const dr = Y.decodeUpdate(r.diff);
    const sig = (u: ReturnType<typeof Y.decodeUpdate>) => JSON.stringify(u.structs.map(st => [st.id, st.length, (st as Y.Item).origin, (st as Y.Item).parentSub, (st as Y.Item).content.constructor.name]));
    expect(sig(dw)).toBe(sig(dr));
    expect(dw.ds.clients.has(4242)).toBe(false);
    expect(dr.ds.clients.has(4242)).toBe(true);
    const baseWriters = new Set(baseClients(state));
    expect([...dw.ds.clients.keys()].every(c => baseWriters.has(c))).toBe(true);

    const cw = await applied(state, w.diff);
    const cr = await applied(state, r.diff);
    expect(xmlOf(cw)).toBe(xmlOf(cr));
    expect(topIds(cw)).toEqual(topIds(cr));
  });

  it("a reinserted copy that differs from the block it replaces: byte-identical diff", async () => {
    const state = stateOf(await docOf([H("hA", "A"), P("a1", "a1 text")]));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (_ed, e) => void e.replace(["hA", "a1"], [H("hA", "A changed"), P("a1", "a1 old")]));
    const r = await referenceWrite(rt, state, 4242, ed => {
      ed.insertBlocks([H("hA", "A changed"), P("a1", "a1 old")], "a1", "after");
      ed.removeBlocks(["hA", "a1"]);
    });
    expect(topIds(fork)).toEqual(["hA", "a1"]);
    expect(sameBytes(w.diff, r.diff)).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));
  });

  it("fn throws: nothing removed or renamed, the error propagates, and the next withForkEditor can open", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const { fork, sv } = forkWithClient(state, 4242);
    await expect(
      withForkEditor(rt, fork, sv, (_ed, e) => {
        e.replace(["hB"], [P("n1", "x")]);
        e.rename(new Map([["n1", "hB"]]));
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(rt.inFlight).toBe(0);
    expect(topIds(fork)).toEqual(["hA", "a1", "a2", "hB", "n1", "b1", "b2", "hC", "c1"]);
    const next = await withForkEditor(rt, fork, sv, (_ed, e) => e.remove(["n1"]));
    expect(next.value).toBeNull();
    expect(topIds(fork)).toEqual(BASE_IDS);
  });

  it("isQueued reports exactly the queued ids", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const { fork, sv } = forkWithClient(state, 4242);
    await withForkEditor(rt, fork, sv, (_ed, e) => {
      expect(e.isQueued("a1")).toBe(false);
      e.replace(["a1"], [P("n1", "x")]);
      e.remove(["hB"]);
      expect(e.isQueued("a1")).toBe(true);
      expect(e.isQueued("hB")).toBe(true);
      expect(e.isQueued("a2")).toBe(false);
      expect(e.isQueued("n1")).toBe(false);
      expect([...e.removals]).toEqual(["a1", "hB"]);
    });
  });
});

describe("merging into a live doc (#553)", () => {
  type User = (ed: AnyEditor) => void;
  it.each<[string, User]>([
    ["typing inside a removed block", ed => void ed.updateBlock("b1", { content: "b1 TYPED" })],
    ["a paragraph inserted right before the target heading", ed => void ed.insertBlocks([P("u1", "USER-NEW")], "hB", "before")],
    ["a paragraph inserted right after the last removed block", ed => void ed.insertBlocks([P("u1", "USER-AFTER")], "b2", "after")],
    ["a removed block deleted", ed => void ed.removeBlocks(["b1"])],
    ["typing in another section", ed => void ed.updateBlock("a1", { content: "a1 EDITED" })],
  ])("%s: same merged document as the editor-level removal, ids unique (10 client ids)", async (_n, user) => {
    const state = stateOf(await docOf(baseBlocks()));
    for (let i = 0; i < 10; i++) {
      const forkClient = 1000 + i * 7919;
      const browser = new Y.Doc();
      browser.clientID = 900_000 + i * 104_729;
      Y.applyUpdate(browser, state);
      const bsv = Y.encodeStateVector(browser);
      const s = await EditorSession.open(rt, browser);
      try {
        user(s.editor);
      } finally {
        s.close();
      }
      const browserUpdate = Y.encodeStateAsUpdate(browser, bsv);

      const { fork, sv } = forkWithClient(state, forkClient);
      const w = await withForkEditor(rt, fork, sv, (_ed, e) => void e.replace(["hB", "b1", "b2"], newB()));
      const r = await referenceWrite(rt, state, forkClient, ed => {
        ed.insertBlocks(newB(), "b2", "after");
        ed.removeBlocks(["hB", "b1", "b2"]);
      });
      const merged = (diff: Uint8Array): Y.Doc => {
        const live = new Y.Doc();
        Y.applyUpdate(live, state);
        Y.applyUpdate(live, browserUpdate);
        Y.applyUpdate(live, diff);
        return live;
      };
      const mw = merged(w.diff);
      const mr = merged(r.diff);
      expect(xmlOf(mw)).toBe(xmlOf(mr));
      expect(new Set(allBlockIds(mw)).size).toBe(allBlockIds(mw).length);
    }
  }, 120_000);

  it("an editor mounted on the live doc while the update arrives keeps every id and adds no struct", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await withForkEditor(rt, fork, sv, (_ed, e) => void e.replace(["hB", "b1", "b2"], newB()));
    const live = new Y.Doc();
    Y.applyUpdate(live, state);
    const s = await EditorSession.open(rt, live);
    let clock: number;
    try {
      Y.applyUpdate(live, w.diff);
      expect(s.editor.document.map(b => b.id)).toEqual(["hA", "a1", "a2", "n1", "n2", "n3", "hC", "c1"]);
      clock = totalClock(live);
    } finally {
      s.close();
    }
    expect(totalClock(live)).toBe(clock);
    expect(topIds(live)).toEqual(["hA", "a1", "a2", "n1", "n2", "n3", "hC", "c1"]);
    expect(new Set(allBlockIds(live)).size).toBe(allBlockIds(live).length);
  });
});

describe("cost (#553)", () => {
  it("replacing all of a 4,000-paragraph note costs little more than inserting 4,000 paragraphs", async () => {
    const state = stateOf(yjsNote(4_000));
    const allIds = Array.from({ length: 4_000 }, (_, i) => `q${i}`);
    const blocks = Array.from({ length: 4_000 }, (_, i) => P(`m${i}`, `m${i}`));
    let minReplace = Infinity;
    let minInsert = Infinity;
    for (let run = 0; run < 3; run++) {
      for (const replace of [true, false]) {
        const { fork, sv } = forkFrom(state);
        const ms = await timeIt(() =>
          withForkEditor(rt, fork, sv, (ed, e) => {
            if (replace) e.replace(allIds, blocks);
            else ed.insertBlocks(blocks, "q3999", "after");
          })
        );
        if (replace) {
          minReplace = Math.min(minReplace, ms);
          expect(topIds(fork)).toHaveLength(4_000);
        } else minInsert = Math.min(minInsert, ms);
      }
    }
    console.log(`[perf] #553 replace all 4,000: minReplace=${Math.round(minReplace)} ms minInsert=${Math.round(minInsert)} ms`);
    expect(minReplace).toBeLessThanOrEqual(1.5 * minInsert + 200);
  }, 120_000);

  it("topLevelBlocksById keeps the first block of a duplicated top-level id; pickBlocks follows the order of the ids and skips missing ones", async () => {
    const doc = await docOf([P("a", "t0"), P("b", "t1")]);
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.insertBlocks([P("a", "t2")], "b", "after");
      expect(s.editor.document.map(b => b.id)).toEqual(["a", "b", "a"]);
      const byId = topLevelBlocksById(s.editor);
      const text = (b: { content?: unknown }) => (b.content as Array<{ text: string }>).map(c => c.text).join("");
      expect(text(byId.get("a")!)).toBe("t0");
      expect(pickBlocks(byId, ["b", "x", "a"]).map(text)).toEqual(["t1", "t0"]);
    } finally {
      s.close();
    }
  });

  it("topLevelBlocksById + pickBlocks of 1,000/8,000 ids is linear", async () => {
    await expectLinear(
      "#553 topLevelBlocksById",
      async n => {
        const doc = yjsNote(n);
        const ids = Array.from({ length: n }, (_, i) => `q${i}`);
        const s = await EditorSession.open(rt, doc);
        try {
          await yieldToLoop();
          const t = performance.now();
          const picked = pickBlocks(topLevelBlocksById(s.editor), ids);
          const ms = performance.now() - t;
          expect(picked.map(b => b.id)).toEqual(ids);
          return ms;
        } finally {
          s.close();
        }
      },
      8_000
    );
  }, 120_000);
});

describe("referenceApplySync fixture", () => {
  it("gives the same diff as applySync as it is written today", async () => {
    const doc = await docWith(rt, [P("s1", "A"), P("s2", "B"), P("s3", "C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const planned = await planInMemory(rt, b, "A\n\nB2\n\nC", live);
    if (!planned.ok) throw new Error(`plan failed: ${planned.code}`);
    const state = stateOf(live);
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await applySync(rt, fork, sv, planned.plan, planned.cur);
    const r = await referenceApplySync(rt, state, 4242, planned.plan, planned.cur);
    expect(sameBytes(w.diff, r.diff)).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(r.doc));
    expect(w.perRegion).toEqual(r.perRegion);
  });
});
