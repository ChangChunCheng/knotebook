import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelContainers } from "@knotebook/shared";
import { EMPTY_SECTION_FINGERPRINT, fingerprintForIds, fingerprintOf, outlineOf } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function docWith(blocks: Array<Record<string, unknown>>): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  s.editor.replaceBlocks(s.editor.document, blocks as never);
  s.close();
  return doc;
}

const COL = (id: string, children: Array<Record<string, unknown>>, width = 1) => ({ id, type: "column", props: { width }, children });
const ROW = (id: string, cols: Array<Record<string, unknown>>) => ({ id, type: "columnList", children: cols });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: text });
// Golden values captured from the implementation before the topLevelContainers change: existing documents' fingerprints must stay byte-identical.
const GOLDEN_OUTLINE = [["_top", 0, "e3b0c44298fc1c14"], ["ha", 12, "70cfcd4d638d7496"], ["hb", 4, "69c7d471720fc8fd"]];
const GOLDEN_WHOLE = "02384cdbb1c6229a";
const GOLDEN_BLOCKS = [
  { id: "ha", type: "heading", props: { level: 1 }, content: "A" },
  para("p1", "段落一"),
  { id: "li", type: "bulletListItem", content: "清單", children: [{ id: "li2", type: "bulletListItem", content: "子項" }] },
  { id: "tb", type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }] } },
  { id: "hb", type: "heading", props: { level: 1 }, content: "B" },
  para("p2", "段落二"),
];

describe("fingerprint", () => {
  it("fingerprints of existing documents without columns are byte-for-byte unchanged (golden)", async () => {
    const doc = await docWith(GOLDEN_BLOCKS);
    const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(outline.map(o => [o.sectionId, o.chars, o.fingerprint])).toEqual(GOLDEN_OUTLINE);
    expect(whole).toBe(GOLDEN_WHOLE);
  });

  it("document with only one row -> outlineOf does not throw, _top.blockIds is that row's id", async () => {
    const doc = await docWith([ROW("r", [COL("r1", [para("a", "左")]), COL("r2", [para("b", "右")])])]);
    const { outline } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(outline[0]!.blockIds).toEqual(["r"]);
    expect(outline[0]!.chars).toBe(2);
  });

  it("differing only in a column's width -> different _top fingerprint; differing only in column id -> same", async () => {
    const mk = (w: number, c1: string) => docWith([ROW("r", [COL(c1, [para("a", "左")], w), COL("r2", [para("b", "右")])])]);
    const top = async (d: Promise<Y.Doc>) => outlineOf((await d).getXmlFragment(YDOC_FRAGMENT)).outline[0]!.fingerprint;
    expect(await top(mk(1, "r1"))).not.toBe(await top(mk(2, "r1")));
    expect(await top(mk(1, "r1"))).toBe(await top(mk(1, "other")));
  });

  it("16 hex; the empty canonical string has a fixed value; an empty _top uses it and counts toward the whole", async () => {
    expect(fingerprintOf("")).toMatch(/^[0-9a-f]{16}$/);
    expect(EMPTY_SECTION_FINGERPRINT).toBe(fingerprintOf(""));
    const doc = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }]);
    const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(outline[0]).toMatchObject({ sectionId: "_top", fingerprint: EMPTY_SECTION_FINGERPRINT, chars: 0 });
    expect(whole).toBe(fingerprintOf(outline.map(o => o.fingerprint).join("")));
  });

  it("whole fingerprint is sensitive to section order; same content with different ids is identical", async () => {
    const a = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }, { type: "heading", props: { level: 1 }, content: "B" }]);
    const b = await docWith([{ type: "heading", props: { level: 1 }, content: "B" }, { type: "heading", props: { level: 1 }, content: "A" }]);
    const c = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }, { type: "heading", props: { level: 1 }, content: "B" }]);
    expect(outlineOf(a.getXmlFragment(YDOC_FRAGMENT)).whole).not.toBe(outlineOf(b.getXmlFragment(YDOC_FRAGMENT)).whole);
    expect(outlineOf(a.getXmlFragment(YDOC_FRAGMENT)).whole).toBe(outlineOf(c.getXmlFragment(YDOC_FRAGMENT)).whole);
  });

  it("fingerprintForIds: changed order or a missing id -> null; empty -> EMPTY_SECTION_FINGERPRINT", async () => {
    const doc = await docWith([{ type: "paragraph", content: "1" }, { type: "paragraph", content: "2" }]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    const [a, b] = topLevelContainers(f).map(c => c.getAttribute("id")!);
    expect(fingerprintForIds(f, [a, b])).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintForIds(f, [b, a])).toBeNull();
    expect(fingerprintForIds(f, [a, "zzz"])).toBeNull();
    expect(fingerprintForIds(f, [])).toBe(EMPTY_SECTION_FINGERPRINT);
  });

  it("pins blockContainer's attribute set to exactly {id} (goes red on a BlockNote upgrade)", () => {
    const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") });
    expect(Object.keys(editor.pmSchema.nodes.blockContainer!.spec.attrs ?? {}).sort()).toEqual(["id"]);
  });

  it("section fingerprint equals fingerprintForIds(its blockIds): multi-block sections follow document order", async () => {
    const doc = await docWith([
      { id: "c-h", type: "heading", props: { level: 1 }, content: "H" },
      { id: "b-x", type: "paragraph", content: "X" },
      { id: "a-y", type: "paragraph", content: "Y" },
    ]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(topLevelContainers(f).map(c => c.getAttribute("id"))).toEqual(["c-h", "b-x", "a-y"]);
    const { outline } = doc.transact(() => outlineOf(f));
    const sec = outline[1]!;
    expect(sec.blockIds).toEqual(["c-h", "b-x", "a-y"]);
    expect(sec.fingerprint).toBe(fingerprintForIds(f, sec.blockIds));
    expect(fingerprintForIds(f, [...sec.blockIds].reverse())).toBeNull();
  });

  it("outlineOf: a top-level blockContainer missing the id attribute -> throws", () => {
    const doc = new Y.Doc();
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    group.insert(0, [container]);
    f.insert(0, [group]);
    expect(() => outlineOf(f)).toThrow(/缺 id 屬性/);
  });
});
