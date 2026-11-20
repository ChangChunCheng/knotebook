/**
 * #553: revert removes the edit's blocks at the Yjs layer after the editor is closed. The update must equal the one the editor-level removal produced, and the cost must grow with the blocks reverted.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { fingerprintForIds } from "../../src/notes/editing/fingerprint.js";
import { LiveWatch, containerItems } from "../../src/notes/editing/live-watch.js";
import { prepareRevertOnFork, type RevertRow } from "../../src/notes/editing/revert-core.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom, pickBlocks, topLevelBlocksById, withForkEditor, type AnyBlock, type AnyEditor, type AnyPartialBlock } from "../../src/notes/editing/session.js";
import { timeIt, yieldToLoop } from "../perf-helpers.js";
import { allBlockIds, topIds, totalClock } from "./fixtures/block-ids.js";
import { forkWithClient, referenceWrite } from "./fixtures/removal-reference.js";
import { yjsNote } from "./fixtures/yjs-note.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const H = (id: string, t: string): AnyPartialBlock => ({ id, type: "heading", props: { level: 1 }, content: t });
const P = (id: string, t: string): AnyPartialBlock => ({ id, type: "paragraph", content: t });
const xmlOf = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();
const maskedXml = (doc: Y.Doc): string => xmlOf(doc).replace(/id="[^"]*"/g, 'id="X"');
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const stateOf = (doc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(doc);

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

/** The revert as it was written before removal moved to the Yjs layer. */
function oldRevert(ed: AnyEditor, row: RevertRow, othersShareAnchor: boolean): { reinsertedIds: string[]; removedSnapshot: AnyBlock[] } {
  const anchor = row.anchor;
  const before = row.beforeBlocks as AnyPartialBlock[];
  const removedSnapshot = row.afterBlockIds.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
  let reinsertedIds: string[] = [];
  const wouldBeEmpty = (removing: string[]) => ed.document.every(b => removing.includes(b.id));
  const revertReplace = () => {
    if (before.length === 0 && wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]);
    else {
      reinsertedIds = ed.insertBlocks(before, row.afterBlockIds[row.afterBlockIds.length - 1]!, "after").map(b => b.id);
      ed.removeBlocks(row.afterBlockIds);
    }
  };
  const revertInsert = () => {
    if (wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]);
    else ed.removeBlocks(row.afterBlockIds);
  };
  const revertDelete = (removeAnchor: (isEmptyParagraph: boolean) => boolean) => {
    reinsertedIds = ed.insertBlocks(before, anchor!.block_id, anchor!.position).map(b => b.id);
    const a = ed.getBlock(anchor!.block_id);
    const isEmptyParagraph = a !== undefined && a.type === "paragraph" && (!Array.isArray(a.content) || a.content.length === 0) && (!Array.isArray(a.children) || a.children.length === 0);
    if (removeAnchor(isEmptyParagraph)) ed.removeBlocks([anchor!.block_id]);
  };
  switch (row.op) {
    case "replace_all": case "replace_section": revertReplace(); break;
    case "insert_after": case "append": revertInsert(); break;
    case "delete_section": revertDelete(isEmpty => anchor!.position === "before" && isEmpty); break;
    case "file_sync": {
      if (row.anchor !== null && row.anchor !== undefined) revertDelete(isEmpty => anchor!.placeholder === true && isEmpty && !othersShareAnchor);
      else if (before.length > 0) revertReplace();
      else revertInsert();
      break;
    }
  }
  return { reinsertedIds, removedSnapshot };
}

async function refRevert(state: Uint8Array, row: RevertRow, othersShareAnchor: boolean) {
  let out!: ReturnType<typeof oldRevert>;
  const r = await referenceWrite(rt, state, 4242, ed => {
    out = oldRevert(ed, row, othersShareAnchor);
  });
  return { ...r, ...out };
}

const row = (op: string, afterBlockIds: string[], beforeBlocks: AnyPartialBlock[], anchor: RevertRow["anchor"] = null): RevertRow => ({ op, afterBlockIds, afterFingerprint: null, beforeBlocks, anchor });

const phBase = (): AnyPartialBlock[] => [P("ph", ""), H("hA", "A"), P("a1", "a1 text")];

describe("prepareRevertOnFork removes at the Yjs layer (#553)", () => {
  const shapes: Array<[string, () => AnyPartialBlock[], RevertRow, boolean]> = [
    ["replace_section", baseBlocks, row("replace_section", ["hB", "b1", "b2"], [H("o1", "B old"), P("o2", "b1 old"), P("o3", "b2 old")]), false],
    ["replace_all", baseBlocks, row("replace_all", BASE_IDS, [P("o1", "old one"), P("o2", "old two")]), false],
    ["append", baseBlocks, row("append", ["c1"], []), false],
    ["insert_after", baseBlocks, row("insert_after", ["a2"], []), false],
    ["delete_section (anchor after)", baseBlocks, row("delete_section", [], [H("o1", "S"), P("o2", "s1")], { block_id: "a2", position: "after" }), false],
    ["delete_section (anchor is an empty paragraph, before)", phBase, row("delete_section", [], [H("o1", "S"), P("o2", "s1")], { block_id: "ph", position: "before" }), false],
    ["file_sync rewrite", baseBlocks, row("file_sync", ["a1", "a2"], [P("o1", "x"), P("o2", "y")]), false],
    ["file_sync delete with a placeholder anchor", phBase, row("file_sync", [], [H("o1", "S"), P("o2", "s1")], { block_id: "ph", position: "before", placeholder: true }), false],
  ];

  it.each(shapes)("%s: byte-identical diff, same reinsertedIds and removedSnapshot as the editor-level path", async (_n, base, r, others) => {
    const state = stateOf(await docOf(base()));
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await prepareRevertOnFork(rt, r, fork, sv, others);
    const ref = await refRevert(state, r, others);
    expect(sameBytes(w.diff, ref.diff)).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(ref.doc));
    expect(w.reinsertedIds).toEqual(ref.reinsertedIds);
    expect(w.removedSnapshot).toEqual(ref.removedSnapshot);
  });

  it("the placeholder anchor is kept when another unreverted row shares it", async () => {
    const state = stateOf(await docOf(phBase()));
    const { fork, sv } = forkWithClient(state, 4242);
    const r = row("file_sync", [], [H("o1", "S")], { block_id: "ph", position: "before", placeholder: true });
    await prepareRevertOnFork(rt, r, fork, sv, true);
    expect(topIds(fork)).toEqual(["o1", "ph", "hA", "a1"]);
  });

  // The old content diff keeps a before-block that equals its after copy and drops the copy; removal at the Yjs layer deletes the after copy's container. The result reads the same, only the delete set differs.
  async function keptIdRewrite(beforeBlocks: AnyPartialBlock[]) {
    const state = stateOf(await docOf(baseBlocks()));
    const rewritten = forkWithClient(state, 777);
    await withForkEditor(rt, rewritten.fork, rewritten.sv, (_ed, e) => void e.replace(["hB", "b1", "b2"], [H("hB", "B"), P("b1", "b1 new"), P("b2", "b2 new")]));
    const after = stateOf(rewritten.fork);
    const r = row("replace_section", ["hB", "b1", "b2"], beforeBlocks);
    return { after, r };
  }

  it("revert of a kept-id replace_section where every before-block differs from its after block: byte-identical, each id once, content restored", async () => {
    const { after, r } = await keptIdRewrite([H("hB", "B old"), P("b1", "b1 old"), P("b2", "b2 old")]);
    const { fork, sv } = forkWithClient(after, 4242);
    const w = await prepareRevertOnFork(rt, r, fork, sv, false);
    const ref = await refRevert(after, r, false);
    expect(sameBytes(w.diff, ref.diff)).toBe(true);
    expect(xmlOf(fork)).toBe(xmlOf(ref.doc));
    expect(topIds(fork)).toEqual(BASE_IDS);
    expect(new Set(allBlockIds(fork)).size).toBe(allBlockIds(fork).length);
    expect(xmlOf(fork)).toContain("b1 old");
    expect(xmlOf(fork)).not.toContain("b1 new");
  });

  it("revert of a kept-id replace_section where a before-block equals its after block: same document and inserted structs; the after copy is the one deleted", async () => {
    const { after, r } = await keptIdRewrite([H("hB", "B"), P("b1", "b1 old"), P("b2", "b2 old")]);
    const { fork, sv } = forkWithClient(after, 4242);
    const w = await prepareRevertOnFork(rt, r, fork, sv, false);
    const ref = await refRevert(after, r, false);
    expect(xmlOf(fork)).toBe(xmlOf(ref.doc));
    expect(topIds(fork)).toEqual(topIds(ref.doc));
    expect(topIds(fork)).toEqual(BASE_IDS);
    expect(new Set(allBlockIds(fork)).size).toBe(allBlockIds(fork).length);

    const dw = Y.decodeUpdate(w.diff);
    const dr = Y.decodeUpdate(ref.diff);
    const sig = (u: ReturnType<typeof Y.decodeUpdate>) => JSON.stringify(u.structs.map(st => [st.id, st.length, (st as Y.Item).origin, (st as Y.Item).parentSub, (st as Y.Item).content.constructor.name]));
    expect(sig(dw)).toBe(sig(dr));
    expect(dw.ds.clients.has(4242)).toBe(false);
    expect(dr.ds.clients.has(4242)).toBe(true);

    const apply = (diff: Uint8Array) => {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, after);
      Y.applyUpdate(copy, diff);
      return copy;
    };
    expect(xmlOf(apply(w.diff))).toBe(xmlOf(apply(ref.diff)));
  });

  it("revert of an append into an empty note leaves one empty paragraph", async () => {
    const state = stateOf(await docOf([P("x1", "typed by the agent")]));
    const r = row("append", ["x1"], []);
    const { fork, sv } = forkWithClient(state, 4242);
    const w = await prepareRevertOnFork(rt, r, fork, sv, false);
    const ref = await refRevert(state, r, false);
    expect(topIds(fork)).toHaveLength(1);
    expect(topIds(fork)[0]).not.toBe("x1");
    expect(maskedXml(fork)).toBe(maskedXml(ref.doc));
    expect(xmlOf(fork)).not.toContain("typed by the agent");
    const copy = new Y.Doc();
    Y.applyUpdate(copy, state);
    Y.applyUpdate(copy, w.diff);
    expect(maskedXml(copy)).toBe(maskedXml(ref.doc));
  });

  it("a user paragraph between two of the edit's blocks: same document as the editor-level path, the user paragraph intact, and the update only deletes the edit's blocks and inserts the before-blocks", async () => {
    const doc = await docOf(baseBlocks());
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.insertBlocks([P("u1", "USER PARAGRAPH")], "b1", "after");
    } finally {
      s.close();
    }
    const state = stateOf(doc);
    const r = row("replace_section", ["hB", "b1", "b2"], [H("o1", "B old"), P("o2", "b1 old"), P("o3", "b2 old")]);
    const base = forkFrom(state).fork;
    const afterKeys = containerItems(base.getXmlFragment(YDOC_FRAGMENT), ["hB", "b1", "b2"]);
    const userKey = containerItems(base.getXmlFragment(YDOC_FRAGMENT), ["u1"]);
    expect(afterKeys).toHaveLength(3);
    expect(userKey).toHaveLength(1);

    const { fork, sv } = forkWithClient(state, 4242);
    const w = await prepareRevertOnFork(rt, r, fork, sv, false);
    const ref = await refRevert(state, r, false);
    expect(xmlOf(fork)).toBe(xmlOf(ref.doc));
    expect(topIds(fork)).toEqual(["hA", "a1", "a2", "u1", "o1", "o2", "o3", "hC", "c1"]);
    expect(xmlOf(fork)).toContain("USER PARAGRAPH");

    const d = Y.decodeUpdate(w.diff);
    const deleted = (key: string) => {
      const [client, clock] = key.split(":").map(Number) as [number, number];
      return Y.isDeleted(d.ds, Y.createID(client, clock));
    };
    for (const k of afterKeys) expect(deleted(k)).toBe(true);
    expect(deleted(userKey[0]!)).toBe(false);
    expect(d.structs.every(st => st.id.client === 4242)).toBe(true);
    let deletedRuns = 0;
    for (const items of d.ds.clients.values()) deletedRuns += items.length;
    expect(deletedRuns).toBeGreaterThan(0);
  });

  it("reverting a 4,000-block replace_all costs little more than inserting 4,000 blocks", async () => {
    const state = stateOf(yjsNote(4_000));
    const allIds = Array.from({ length: 4_000 }, (_, i) => `q${i}`);
    const before = Array.from({ length: 4_000 }, (_, i) => P(`m${i}`, `m${i}`));
    const r = row("replace_all", allIds, before);
    let minRevert = Infinity;
    let minInsert = Infinity;
    for (let run = 0; run < 3; run++) {
      for (const revert of [true, false]) {
        const { fork, sv } = forkFrom(state);
        const ms = await timeIt(() => (revert ? prepareRevertOnFork(rt, r, fork, sv, false) : withForkEditor(rt, fork, sv, ed => void ed.insertBlocks(before, "q3999", "after"))));
        if (revert) {
          minRevert = Math.min(minRevert, ms);
          expect(topIds(fork)).toHaveLength(4_000);
          expect(topIds(fork)[0]).toBe("m0");
        } else minInsert = Math.min(minInsert, ms);
      }
    }
    console.log(`[perf] #553 revert replace_all 4,000: minRevert=${Math.round(minRevert)} ms minInsert=${Math.round(minInsert)} ms`);
    expect(minRevert).toBeLessThanOrEqual(1.5 * minInsert + 200);
  }, 120_000);
});

describe("revert of an id-keeping rewrite while another client types inside an identical block (#553)", () => {
  it("the guard refuses the revert and the typed text stays in the live doc", async () => {
    const original = await docOf(baseBlocks());
    // The rewrite changes only b1; hB and b2 keep id and content, so the revert re-inserts copies of them that equal the blocks it deletes.
    const rewritten = forkFrom(stateOf(original));
    let beforeBlocks: AnyBlock[] = [];
    await withForkEditor(rt, rewritten.fork, rewritten.sv, (ed, e) => {
      beforeBlocks = pickBlocks(topLevelBlocksById(ed), ["hB", "b1", "b2"]);
      e.replace(["hB", "b1", "b2"], [H("hB", "B"), P("b1", "b1 new"), P("b2", "b2 text")]);
    });
    const live = new Y.Doc();
    Y.applyUpdate(live, stateOf(rewritten.fork));
    const afterIds = ["hB", "b1", "b2"];
    const revertRow: RevertRow = {
      op: "replace_section",
      afterBlockIds: afterIds,
      afterFingerprint: fingerprintForIds(live.getXmlFragment(YDOC_FRAGMENT), afterIds),
      beforeBlocks,
      anchor: null,
    };

    const rr = await rt.runDoc("u", { kind: "revert", state: stateOf(live), othersShareAnchor: false, row: revertRow } as never);
    if (rr === "too_complex" || !("ok" in rr) || !rr.ok) throw new Error("revert " + JSON.stringify(rr));
    const guard = rr.post.guard;
    expect(guard.kind).toBe("blocks");

    const watch = new LiveWatch(live);
    const keys = containerItems(live.getXmlFragment(YDOC_FRAGMENT), afterIds);
    expect(keys).toHaveLength(3);
    expect(watch.conflicts(guard)).toBe(false);

    const browser = new Y.Doc();
    browser.clientID = 900_001;
    Y.applyUpdate(browser, stateOf(live));
    const bsv = Y.encodeStateVector(browser);
    const s = await EditorSession.open(rt, browser);
    try {
      s.editor.updateBlock("b2", { content: "b2 text TYPED" });
    } finally {
      s.close();
    }
    Y.applyUpdate(live, Y.encodeStateAsUpdate(browser, bsv));
    expect(watch.conflicts(guard)).toBe(true);
    expect(xmlOf(live)).toContain("b2 text TYPED");
    watch.stop();
  });

  it("typing in a block outside the reverted section does not conflict", async () => {
    const original = await docOf(baseBlocks());
    const rewritten = forkFrom(stateOf(original));
    await withForkEditor(rt, rewritten.fork, rewritten.sv, (_ed, e) => void e.replace(["hB", "b1", "b2"], [H("hB", "B"), P("b1", "b1 new"), P("b2", "b2 text")]));
    const live = new Y.Doc();
    Y.applyUpdate(live, stateOf(rewritten.fork));
    const guard = { kind: "blocks" as const, items: containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["hB", "b1", "b2"]), anchors: [] };
    const watch = new LiveWatch(live);
    const browser = new Y.Doc();
    browser.clientID = 900_002;
    Y.applyUpdate(browser, stateOf(live));
    const bsv = Y.encodeStateVector(browser);
    const s = await EditorSession.open(rt, browser);
    try {
      s.editor.updateBlock("a1", { content: "a1 TYPED" });
    } finally {
      s.close();
    }
    Y.applyUpdate(live, Y.encodeStateAsUpdate(browser, bsv));
    expect(watch.conflicts(guard)).toBe(false);
    expect(totalClock(live)).toBeGreaterThan(0);
    watch.stop();
  });
});
