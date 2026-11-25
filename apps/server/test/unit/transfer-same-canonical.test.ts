import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, YDOC_FRAGMENT, canonicalizeElements, topLevelBlocks } from "@knotebook/shared";
import { fingerprintOf, topLevelFingerprints, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { toNoteMarkdown } from "../../src/notes/editing/read.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { sameCanonicalOf, sameCanonicalSeq } from "../../src/transfer/same-canonical.js";
import { SHAPE_LINK_TARGET, SHAPE_TITLES, TRANSFER_SHAPES, type ShapeBlock } from "./fixtures/transfer-shapes.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const SITE = "http://localhost";
const CANDIDATES = [{ id: SHAPE_LINK_TARGET, title: "Other note", slug: "other-note", groupId: null, ownerHandle: "owner" }];
const frag = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);

async function docWith(blocks: ShapeBlock[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
async function withEditor<T>(doc: Y.Doc, f: (ed: EditorSession["editor"]) => T): Promise<T> {
  const s = await EditorSession.open(rt, doc);
  try {
    return f(s.editor);
  } finally {
    s.close();
  }
}
async function scratchOf(md: string, stripStart: boolean): Promise<{ frag: Y.XmlFragment; ids: string[] }> {
  const doc = new Y.Doc();
  const ids = await withEditor(doc, ed => {
    const p = parseMarkdownForNote(ed, md, CANDIDATES, SITE);
    if ("error" in p) throw new Error(p.error);
    const blocks = p.blocks;
    if (stripStart && blocks[0]?.type === "numberedListItem" && blocks[0].props) delete (blocks[0].props as Record<string, unknown>).start;
    return ed.insertBlocks(blocks, ed.document[0]!.id, "before").map(b => b.id);
  });
  return { frag: frag(doc), ids };
}
const fpsOf = (f: Y.XmlFragment, ids: string[]) => {
  const byId = new Map(topLevelBlocks(f).map(c => [c.getAttribute("id"), c]));
  return ids.map(id => fingerprintOf(canonicalizeElements([byId.get(id)!])));
};
const paras = (n: number): ShapeBlock[] => Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: `p${i}` }));

describe("topLevelSnapshot", () => {
  it.each(TRANSFER_SHAPES.map(s => [`[${s.group}] ${s.name}`, s] as const))("%s: ids/fps = topLevelFingerprints, types = the type in editor.document", async (_l, shape) => {
    const doc = await docWith(shape.blocks);
    const snap = topLevelSnapshot(frag(doc));
    const tf = topLevelFingerprints(frag(doc));
    expect(snap.ids).toEqual(tf.ids);
    expect(snap.fps).toEqual(tf.fps);
    const types = await withEditor(doc, ed => ed.document.map(b => b.type as string));
    expect(snap.types).toEqual(types);
  });
  it("a missing id throws", () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    frag(doc).insert(0, [g]);
    g.insert(0, [new Y.XmlElement("blockContainer")]);
    expect(() => topLevelSnapshot(frag(doc))).toThrow();
  });
});

describe("performance (single pass)", () => {
  it("2 000 blocks: topLevelSnapshot < 500 ms", async () => {
    const doc = await docWith(paras(2000));
    const t0 = performance.now();
    const snap = topLevelSnapshot(frag(doc));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(snap.ids).toHaveLength(2000);
  }, 60_000);
  it("2 000 blocks: sameCanonicalSeq(all ids) < 500 ms", async () => {
    const doc = await docWith(paras(2000));
    const ids = topLevelSnapshot(frag(doc)).ids;
    const t0 = performance.now();
    const seq = sameCanonicalSeq(frag(doc), ids);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(seq).toHaveLength(2000);
  }, 60_000);
});

/** The agent's region text is the export of the block after the human's edit (a numbered middle item uses the numbering from the whole-note export). */
describe("a human already made the same edit -> sameCanonical equal, fingerprints not equal (premise)", () => {
  const N = (t: string): ShapeBlock => ({ type: "numberedListItem", content: t });
  async function humanEdited(blocks: ShapeBlock[], idx: number, edit: (ed: EditorSession["editor"], id: string) => void, opts: { browser?: boolean } = {}) {
    const doc = await docWith(blocks);
    const id = topLevelSnapshot(frag(doc)).ids[idx]!;
    await withEditor(doc, ed => edit(ed, id));
    if (opts.browser) {
      // the shape the browser builds: numbered has no `start` attribute (changing the Y structure directly)
      doc.transact(() => {
        for (const c of topLevelBlocks(frag(doc))) {
          const content = c.get(0);
          if (content instanceof Y.XmlElement && content.nodeName === "numberedListItem") content.removeAttribute("start");
        }
      });
    }
    return { doc, id };
  }
  const cases: Array<[string, () => Promise<{ doc: Y.Doc; id: string }>, (md: string) => string, boolean]> = [
    ["numbered middle item (built by the server)", () => humanEdited([N("a"), N("b"), N("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" })), md => md.replace(/^1\./, "2."), true],
    ["numbered middle item (browser shape)", () => humanEdited([N("a"), N("b"), N("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" }), { browser: true }), md => md.replace(/^1\./, "2."), true],
    [
      "bullet with a wikilink",
      () =>
        humanEdited([{ type: "bulletListItem", content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other" } }, { type: "text", text: " tail", styles: {} }] }], 0, (ed, id) =>
          ed.updateBlock(id, { content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other" } }, { type: "text", text: " tail2", styles: {} }] } as never),
        ),
      md => md,
      false,
    ],
    ["image caption changed", () => humanEdited([{ type: "image", props: { url: "/api/uploads/u1", caption: "cap" } }], 0, (ed, id) => ed.updateBlock(id, { props: { caption: "cap2" } } as never)), md => md, false],
  ];
  it.each(cases)("%s", async (_n, make, toAgent, stripStart) => {
    const { doc, id } = await make();
    const exported = await withEditor(doc, ed => toNoteMarkdown(ed, [ed.getBlock(id)!], SHAPE_TITLES, DEFAULT_KNOWLEDGE_FIELD_VIEW));
    const sc = await scratchOf(toAgent(exported), stripStart);
    expect(sameCanonicalSeq(sc.frag, sc.ids)).toEqual(sameCanonicalSeq(frag(doc), [id]));
    // premise: compared with `fingerprintOf` the same group is not equal (proves sameCanonical is load-bearing)
    expect(fpsOf(sc.frag, sc.ids)).not.toEqual(fpsOf(frag(doc), [id]));
  });
  // The shape where dropping `start` alone is load-bearing: the pre-parse carries a real `start: 2` (the block before the insertion point is no longer numbered, so it was not stripped -
  // "someone deleted the first two items afterwards"), and the current block has no start value. In the two cases above `start` is undefined or absent on both sides, so they do not isolate this.
  it("numbered pre-parse carries start: 2 (not stripped), the current block is already the first item of a list -> equal (rests on dropping start alone)", async () => {
    const { doc, id } = await humanEdited([N("b")], 0, (ed, bid) => ed.updateBlock(bid, { content: "b2" }));
    const sc = await scratchOf("2. b2", false);
    expect(sameCanonicalSeq(sc.frag, sc.ids)).toEqual(sameCanonicalSeq(frag(doc), [id]));
    expect(fpsOf(sc.frag, sc.ids)).not.toEqual(fpsOf(frag(doc), [id]));
  });
});

describe("real edits are not swallowed", () => {
  const wl = (props: Record<string, unknown>): ShapeBlock => ({ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other", ...props } }] });
  const one = async (b: ShapeBlock) => sameCanonicalOf(topLevelBlocks(frag(await docWith([b])))[0]!);
  it.each([
    ["wikilink custom text (label) changed", wl({ label: "mine" }), wl({ label: "yours" })],
    ["wikilink label added", wl({}), wl({ label: "mine" })],
    ["wikilink anchor removed", wl({ anchorBlockId: "abc" }), wl({})],
    ["wikilink anchor added", wl({}), wl({ anchorBlockId: "abc" })],
    ["paragraph changed by one character", { type: "paragraph", content: "hello" }, { type: "paragraph", content: "hellp" }],
    ["empty-string property on a non-wikilink: code language empty vs text", { type: "codeBlock", props: { language: "" }, content: "x" }, { type: "codeBlock", props: { language: "text" }, content: "x" }],
  ] as Array<[string, ShapeBlock, ShapeBlock]>)("%s -> not equal", async (_n, a, b) => {
    expect(await one(a)).not.toBe(await one(b));
  });
  // The shape where "empty-string properties on other elements are still compared" is load-bearing on its own: code `language: ""` against "no language property" (the default `text` is applied on read).
  // The previous case's `""` vs `"text"` differs whether or not empty strings are dropped, so it cannot catch "drop empty-string properties on all elements".
  it("empty-string property on a non-wikilink: code language \"\" vs no language property -> not equal", async () => {
    const doc = await docWith([{ type: "codeBlock", props: { language: "" }, content: "x" }]);
    const a = sameCanonicalOf(topLevelBlocks(frag(doc))[0]!);
    doc.transact(() => {
      const content = topLevelBlocks(frag(doc))[0]!.get(0) as Y.XmlElement;
      content.removeAttribute("language");
    });
    expect(sameCanonicalOf(topLevelBlocks(frag(doc))[0]!)).not.toBe(a);
  });
  it("contrast: wikilinks differing only in snapshotTitle -> equal", async () => {
    expect(await one(wl({ snapshotTitle: "A" }))).toBe(await one(wl({ snapshotTitle: "B" })));
  });
});
