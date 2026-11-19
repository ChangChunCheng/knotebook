import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { isLoneEmptyParagraph } from "../../src/transfer/decide.js";
import { docWith, forkOf, withEditor } from "./fixtures/transfer-sync.js";

/**
 * Write-back decides "has the note changed" by structure: top-level ids + per-block fingerprint (`topLevelSnapshot`). This file checks that the per-block fingerprint
 * covers the text and attributes of the whole block subtree (nested lists, toggle children, table cells, columns, inline styles, block attributes); and `isLoneEmptyParagraph`.
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
type Ed = Parameters<Parameters<typeof withEditor>[2]>[0];
const snap = (doc: Y.Doc) => topLevelSnapshot(doc.getXmlFragment(YDOC_FRAGMENT));

async function before_after(blocks: unknown[], edit: (ed: Ed) => void) {
  const doc = await docWith(rt, blocks);
  const live = forkOf(doc);
  await withEditor(rt, live, edit);
  return [snap(doc), snap(live)] as const;
}
function onlyChanged(a: ReturnType<typeof snap>, b: ReturnType<typeof snap>, k: number) {
  expect(b.ids).toEqual(a.ids);
  a.fps.forEach((fp, i) => (i === k ? expect(b.fps[i], `#${i}`).not.toBe(fp) : expect(b.fps[i], `#${i}`).toBe(fp)));
}

describe("a per-block fingerprint covers the whole subtree", () => {
  it("nested list: changing a child's text, a grandchild's, adding a child -> the parent's fingerprint changes", async () => {
    const blocks = [
      { type: "paragraph", content: "A" },
      { type: "bulletListItem", content: "parent", children: [{ type: "bulletListItem", content: "child", children: [{ type: "bulletListItem", content: "grand" }] }] },
    ];
    const childText = await before_after(blocks, ed => ed.updateBlock(ed.document[1]!.children[0]!.id, { content: "child!" }));
    onlyChanged(...childText, 1);
    const grand = await before_after(blocks, ed => ed.updateBlock(ed.document[1]!.children[0]!.children[0]!.id, { content: "grand!" }));
    onlyChanged(...grand, 1);
    const added = await before_after(blocks, ed => ed.insertBlocks([{ type: "bulletListItem", content: "new" }], ed.document[1]!.children[0]!.id, "after"));
    onlyChanged(...added, 1);
  });
  it("children of a toggle: changing a child paragraph's text -> the toggle's fingerprint changes", async () => {
    const blocks = [{ type: "toggleListItem", content: "T", children: [{ type: "paragraph", content: "inside" }] }, { type: "paragraph", content: "B" }];
    const r = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.children[0]!.id, { content: "inside!" }));
    onlyChanged(...r, 0);
  });
  it("table: changing one cell's text -> the table's fingerprint changes", async () => {
    const table = (cell: string) => ({ type: "table", content: { type: "tableContent", rows: [{ cells: [["a"], ["b"]] }, { cells: [["c"], [cell]] }] } });
    const r = await before_after([{ type: "paragraph", content: "A" }, table("d")], ed => ed.updateBlock(ed.document[1]!.id, table("d!") as never));
    onlyChanged(...r, 1);
  });
  it("inline style (bold only, text unchanged) and block attribute (colour only) -> fingerprint changes", async () => {
    const blocks = [{ type: "paragraph", content: "plain" }, { type: "paragraph", content: "B" }];
    const bold = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.id, { content: [{ type: "text", text: "plain", styles: { bold: true } }] }));
    onlyChanged(...bold, 0);
    const color = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.id, { props: { textColor: "red" } }));
    onlyChanged(...color, 0);
  });
  it("contrast: unchanged -> fingerprints and ids all equal; replacing a block with a new block of the same content -> id changes (matchesBase catches it by id)", async () => {
    const blocks = [{ type: "paragraph", content: "A" }, { type: "paragraph", content: "B" }];
    const same = await before_after(blocks, () => {});
    expect(same[1]).toEqual(same[0]);
    const swapped = await before_after(blocks, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "B" }]));
    expect(swapped[1].fps).toEqual(swapped[0].fps);
    expect(swapped[1].ids[1]).not.toBe(swapped[0].ids[1]);
  });
});

describe("isLoneEmptyParagraph", () => {
  const frag = async (blocks: unknown[], edit?: (ed: Ed) => void) => {
    const doc = await docWith(rt, blocks);
    if (edit) await withEditor(rt, doc, edit);
    return doc.getXmlFragment(YDOC_FRAGMENT);
  };
  it("one empty paragraph -> true; typed then fully deleted -> true; a coloured empty paragraph -> true", async () => {
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph" }]))).toBe(true);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", content: "x" }], ed => ed.updateBlock(ed.document[0]!.id, { content: [] })))).toBe(true);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", props: { backgroundColor: "red" } }]))).toBe(true);
  });
  it("with text, two blocks, not a paragraph, with children, zero blocks -> false", async () => {
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", content: "x" }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph" }, { type: "paragraph" }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "heading", props: { level: 1 } }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", children: [{ type: "paragraph", content: "c" }] }]))).toBe(false);
    expect(isLoneEmptyParagraph(new Y.Doc().getXmlFragment(YDOC_FRAGMENT))).toBe(false);
  });
});
