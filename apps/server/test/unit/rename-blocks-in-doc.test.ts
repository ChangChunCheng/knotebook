/**
 * #551: the rename primitive. A rewrite runs insert-then-remove on a fork with fresh ids, the editor is closed, and the fresh blocks'
 * `id` attributes are then set to the removed blocks' ids at the Yjs layer; the diff is taken after that.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom, renameBlocksInDoc, replaceBlocksFresh } from "../../src/notes/editing/session.js";
import { expectLinear, timeIt, yieldToLoop } from "../perf-helpers.js";
import { allBlockIds, topIds, totalClock } from "./fixtures/block-ids.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const H = (id: string, t: string) => ({ id, type: "heading", props: { level: 1 }, content: t });
const P = (id: string, t: string) => ({ id, type: "paragraph", content: t });
const NH = (t: string) => ({ type: "heading", props: { level: 1 }, content: t });
const NP = (t: string) => ({ type: "paragraph", content: t });

async function docOf(blocks: unknown[]): Promise<Y.Doc> {
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

const baseBlocks = () => [H("hA", "A"), P("a1", "a1 text"), P("a2", "a2 text"), H("hB", "B"), P("b1", "b1 text"), P("b2", "b2 text"), H("hC", "C"), P("c1", "c1 text")];

/** The "browser": a document synced from live runs `f`, then its update is applied back to live. */
async function browser(live: Y.Doc, f: (ed: EditorSession["editor"]) => void): Promise<void> {
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(b);
  const s = await EditorSession.open(rt, b);
  try {
    f(s.editor);
  } finally {
    s.close();
  }
  Y.applyUpdate(live, Y.encodeStateAsUpdate(b, sv));
}

async function markdownOf(doc: Y.Doc): Promise<string> {
  const md = await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(doc), wantShown: false });
  if (md === "too_complex" || typeof md.result === "string" || !("markdown" in md.result)) throw new Error("read");
  return md.result.markdown;
}

interface Written {
  fork: Y.Doc;
  sv: Uint8Array;
  ins: { id: string }[];
  applied: Map<string, string>;
  diff: Uint8Array;
}
/** fork -> session -> replaceBlocksFresh -> close -> (rename) -> diff; one session at a time (`acquire()` isn't reentrant). */
async function write(fork: Y.Doc, sv: Uint8Array, ids: string[], blocks: unknown[], rename: ((ins: { id: string }[]) => Map<string, string>) | null): Promise<Written> {
  const s = await EditorSession.open(rt, fork);
  let ins: { id: string }[];
  try {
    ins = replaceBlocksFresh(s.editor, ids, blocks as never);
  } finally {
    s.close();
  }
  const applied = rename ? renameBlocksInDoc(fork, rename(ins)) : new Map<string, string>();
  return { fork, sv, ins, applied, diff: Y.encodeStateAsUpdate(fork, sv) };
}
const keepB = (ins: { id: string }[]) => new Map([[ins[0]!.id, "hB"], [ins[1]!.id, "b1"], [ins[2]!.id, "b2"]]);
const rewriteB = [NH("B"), NP("b1 text"), NP("AI-NEW")];

describe("renameBlocksInDoc (#551)", () => {
  it("insert-then-remove, close, rename in Yjs: the merged live doc holds the old ids, no duplicates, concurrent typing kept (10 runs)", async () => {
    for (let i = 0; i < 10; i++) {
      const live = await docOf(baseBlocks());
      const { fork, sv } = forkFrom(live);
      const w = await write(fork, sv, ["hB", "b1", "b2"], rewriteB, keepB);
      await browser(live, ed => {
        ed.updateBlock("a1", { content: "a1 text EDITED" });
        ed.insertBlocks([NP("USER-NEW")] as never, "hB", "before");
      });
      Y.applyUpdate(live, w.diff);
      expect(w.applied.size).toBe(3);
      expect(await markdownOf(live)).toBe("# A\n\na1 text EDITED\n\na2 text\n\nUSER-NEW\n\n# B\n\nb1 text\n\nAI-NEW\n\n# C\n\nc1 text\n");
      const top = topIds(live);
      expect([top[0], top[1], top[2], top[4], top[5], top[6], top[7], top[8]]).toEqual(["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"]);
      expect(new Set(allBlockIds(live)).size).toBe(allBlockIds(live).length);
    }
  }, 60_000);

  it("nothing is bound to the fork after close: the rename adds exactly one struct per applied pair", async () => {
    const live = await docOf(baseBlocks());
    const { fork, sv } = forkFrom(live);
    const s = await EditorSession.open(rt, fork);
    let ins: { id: string }[];
    try {
      ins = replaceBlocksFresh(s.editor, ["hB", "b1", "b2"], rewriteB as never);
    } finally {
      s.close();
    }
    const before = totalClock(fork);
    const applied = renameBlocksInDoc(fork, keepB(ins));
    const after = totalClock(fork);
    void sv;
    expect(applied.size).toBe(3);
    console.log(`[probe] clock before=${before} after=${after} delta=${after - before} applied=${applied.size}`);
    expect(after - before).toBe(applied.size);
  });

  it("no duplicate id at any point: in the fork before the rename, in the diff applied to the base alone, and in the persisted state", async () => {
    const live = await docOf(baseBlocks());
    const baseState = Y.encodeStateAsUpdate(live);
    const { fork, sv } = forkFrom(live);
    const s = await EditorSession.open(rt, fork);
    let ins: { id: string }[];
    try {
      ins = replaceBlocksFresh(s.editor, ["hB", "b1", "b2"], rewriteB as never);
    } finally {
      s.close();
    }
    expect(new Set(allBlockIds(fork)).size).toBe(allBlockIds(fork).length);
    renameBlocksInDoc(fork, keepB(ins));
    const diff = Y.encodeStateAsUpdate(fork, sv);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, baseState);
    Y.applyUpdate(copy, diff);
    expect(topIds(copy)).toEqual(["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"]);
    expect(new Set(allBlockIds(copy)).size).toBe(allBlockIds(copy).length);
    Y.applyUpdate(live, diff);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, Y.encodeStateAsUpdate(live));
    expect(new Set(allBlockIds(persisted)).size).toBe(allBlockIds(persisted).length);
    expect(topIds(persisted)).toEqual(["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"]);
  });

  it("an editor mounted on the live doc while the diff arrives (as a browser tab) keeps the renamed ids and writes back no other id", async () => {
    const live = await docOf(baseBlocks());
    const { fork, sv } = forkFrom(live);
    const w = await write(fork, sv, ["hB", "b1", "b2"], rewriteB, keepB);
    const s = await EditorSession.open(rt, live);
    try {
      Y.applyUpdate(live, w.diff);
      expect(s.editor.document.map(b => b.id)).toEqual(["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"]);
    } finally {
      s.close();
    }
    expect(topIds(live)).toEqual(["hA", "a1", "a2", "hB", "b1", "b2", "hC", "c1"]);
    expect(new Set(allBlockIds(live)).size).toBe(allBlockIds(live).length);
  });

  it("renames nested block elements, and skips a missing key and a value already held by any block", async () => {
    const doc = await docOf([P("p1", "x"), { id: "p2", type: "bulletListItem", content: "y", children: [{ id: "c1", type: "bulletListItem", content: "z" }] }]);
    expect(allBlockIds(doc)).toEqual(["p1", "p2", "c1"]);
    expect(renameBlocksInDoc(doc, new Map([["c1", "c9"]]))).toEqual(new Map([["c1", "c9"]]));
    expect(renameBlocksInDoc(doc, new Map([["p1", "c9"], ["missing", "r"]])).size).toBe(0);
    expect(renameBlocksInDoc(doc, new Map([["p1", "q"], ["p2", "q"]]))).toEqual(new Map([["p1", "q"]]));
    expect(allBlockIds(doc)).toEqual(["q", "p2", "c9"]);
    expect(renameBlocksInDoc(doc, new Map()).size).toBe(0);
  });
});

describe("renameBlocksInDoc cost (#551)", () => {
  const parse = async (md: string) => {
    await yieldToLoop();
    const r = await rt.parser.parse({ owner: "u", markdown: md, candidates: [], siteOrigin: "http://localhost" });
    if ("error" in r) throw new Error(JSON.stringify(r));
    return r.blocks;
  };
  const formatted = (n: number) => [
    {
      type: "paragraph",
      props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
      content: Array.from({ length: n }, () => [
        { type: "text", text: "b", styles: { bold: true } },
        { type: "text", text: " ", styles: {} },
        { type: "text", text: "i", styles: { italic: true } },
        { type: "text", text: " ", styles: {} },
      ])
        .flat()
        .slice(0, -1),
      children: [],
    },
  ];

  /** Three interleaved runs per arm on fresh forks of the same state; the min of each. */
  async function compare(state: Uint8Array, oldIds: string[], blocks: unknown[], map: (ins: { id: string }[]) => Map<string, string>): Promise<[number, number]> {
    let minFresh = Infinity;
    let minKeep = Infinity;
    for (let r = 0; r < 3; r++) {
      for (const keep of [false, true]) {
        const { fork, sv } = forkFrom(state);
        await yieldToLoop();
        const t = performance.now();
        const w = await write(fork, sv, oldIds, blocks, keep ? map : null);
        const ms = performance.now() - t;
        if (keep) {
          minKeep = Math.min(minKeep, ms);
          if (oldIds.length === 1) expect(topIds(fork)).toEqual(oldIds);
          expect(w.applied.size).toBeGreaterThan(0);
        } else minFresh = Math.min(minFresh, ms);
      }
    }
    console.log(`[probe] minFresh=${Math.round(minFresh)} ms minKeep=${Math.round(minKeep)} ms`);
    return [minFresh, minKeep];
  }

  it("the large-rewrite guard shape (`x<br>` x 2,000 -> `**b** _i_` x 6,000/48,000) with the rename: linear, keeps the old id, adds little", async () => {
    const base = Y.encodeStateAsUpdate(await docOf(await parse("x<br>".repeat(2_000))));
    const baseDoc = new Y.Doc();
    Y.applyUpdate(baseDoc, base);
    const oldIds = topIds(baseDoc);
    expect(oldIds).toHaveLength(1);
    await expectLinear("#551 replace + rename", async n => {
      const { fork, sv } = forkFrom(base);
      return timeIt(async () => {
        const w = await write(fork, sv, oldIds, formatted(n), ins => new Map([[ins[0]!.id, oldIds[0]!]]));
        expect(w.applied.size).toBe(1);
      });
    }, 48_000);
    const [minFresh, minKeep] = await compare(base, oldIds, formatted(48_000), ins => new Map([[ins[0]!.id, oldIds[0]!]]));
    expect(minKeep).toBeLessThanOrEqual(1.25 * minFresh + 100);
  }, 360_000);

  it("a 20,000-block note whose 2,000-block section is rewritten with all 2,000 renamed: rename overhead is small", async () => {
    const blocks = [H("s0", "S"), ...Array.from({ length: 1_999 }, (_, i) => P(`s${i + 1}`, `s${i} text`)), ...Array.from({ length: 18_000 }, (_, i) => P(`t${i}`, `t${i} text`))];
    const base = Y.encodeStateAsUpdate(await docOf(blocks));
    const oldIds = Array.from({ length: 2_000 }, (_, i) => `s${i}`);
    const rewrite = [NH("S"), ...Array.from({ length: 1_999 }, (_, i) => NP(`s${i} text x`))];
    const { fork, sv } = forkFrom(base);
    await yieldToLoop();
    const t0 = performance.now();
    const w = await write(fork, sv, oldIds, rewrite, null);
    const writeMs = performance.now() - t0;
    const map = new Map(w.ins.map((b, k) => [b.id, oldIds[k]!] as const));
    await yieldToLoop();
    const t1 = performance.now();
    const applied = renameBlocksInDoc(fork, map);
    const renameMs = performance.now() - t1;
    console.log(`[probe] writeMs=${Math.round(writeMs)} renameMs=${Math.round(renameMs)}`);
    expect(renameMs).toBeLessThanOrEqual(0.1 * writeMs + 100);
    expect(applied.size).toBe(2_000);
    expect(topIds(fork).slice(0, 2_000)).toEqual(oldIds);
    expect(new Set(allBlockIds(fork)).size).toBe(20_000);
  }, 360_000);

  it("renameBlocksInDoc of 5,000/40,000 pairs is linear", async () => {
    // The state after a whole-note rewrite is n fresh blocks with the old ones already deleted; replaceBlocksFresh over a whole 10,000-block
    // note is itself quadratic (about 20 s), so the n fresh blocks are built directly and only the rename is timed.
    const states = new Map<number, Uint8Array>();
    for (const n of [5_000, 40_000]) states.set(n, Y.encodeStateAsUpdate(await docOf(Array.from({ length: n }, (_, i) => P(`q${i}`, `p${i}`)))));
    await expectLinear("#551 rename count", async n => {
      const { fork } = forkFrom(states.get(n)!);
      const map = new Map(Array.from({ length: n }, (_, i) => [`q${i}`, `o${i}`] as const));
      await yieldToLoop();
      const t = performance.now();
      const applied = renameBlocksInDoc(fork, map);
      const ms = performance.now() - t;
      expect(applied.size).toBe(n);
      expect(topIds(fork)).toEqual(Array.from({ length: n }, (_, i) => `o${i}`));
      expect(new Set(allBlockIds(fork)).size).toBe(n);
      return ms;
    }, 40_000);
  }, 240_000);
});
