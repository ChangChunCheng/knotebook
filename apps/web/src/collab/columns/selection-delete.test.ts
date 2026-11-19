import { afterEach, describe, expect, it } from "vitest";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { P, integrity, mountEditor, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { removeBlocksKeepColumns } from "./keep-columns";
import { blockIdsForMenuDelete, blockIdsInSelectionForDelete } from "./selection-delete";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  return m.editor;
}

const W = (cols: PartialBlockLike[][]): PartialBlockLike[] => [P("x", "x0"), row(cols, "r"), P("z", "z9")];
const TWO_ROWS = (): PartialBlockLike[] => [
  P("x", "x0"),
  row([[P("a", "a1")], [P("b", "b1")]], "r"),
  P("m", "m1"),
  row([[P("c", "c1")], [P("d", "d1")]], "s"),
  P("z", "z9"),
];
const C1 = () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]);
const C4 = () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]);
const AK_BQ = () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1"), P("q", "q1")]]);
const AB = () => W([[P("a", "a1")], [P("b", "b1")]]);
const C11 = () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")]), P("q", "q1")]]);
const BB_KQ = () => [P("x", "x0"), withChildren(P("bb", "b1"), [P("k", "k1"), P("q", "q1")]), P("z", "z9")];
const A_BK = () => [P("a", "a1"), withChildren(P("b", "b1"), [P("k", "k1")]), P("z", "z9")];
const ROW_BB_KQ = () => W([[P("a", "a1")], [withChildren(P("bb", "b1"), [P("k", "k1"), P("q", "q1")])]]);

function selectFirstCharOfBb(editor: AnyEditor): void {
  editor.setTextCursorPosition("b1", "start");
  editor.transact((tr) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TextSelection is taken from the constructor of the current selection; there is no importable type
    tr.setSelection((tr.selection.constructor as any).create(tr.doc, textPos(editor, "bb", 0), textPos(editor, "bb", 1))),
  );
}

const blocksOf = (editor: AnyEditor) => editor.getSelection()!.blocks.map((b) => `${b.id}:${b.type}`).join(", ");

type Sd1Row = [string, () => PartialBlockLike[], string, string, string, string[], string];
const SD1: Sd1Row[] = [
    ["C1", C1, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    [
      "C2",
      () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]),
      "a1",
      "k1",
      "a1:paragraph, k1:paragraph",
      ["a1", "k1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph:b)]  paragraph:z",
    ],
    ["C3", AK_BQ, "k1", "b1", "k1:paragraph, rc1:column", ["k1", "b1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:q)]  paragraph:z"],
    ["C4", C4, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:c)]  paragraph:z"],
    [
      "C5",
      () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1"), P("r", "r1")]]),
      "a1",
      "c1",
      "a1:paragraph, rc1:column, rc2:column",
      ["a1", "b1", "c1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:r)]  paragraph:z",
    ],
    [
      "C6",
      () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")], [P("c", "c1"), P("r", "r1")]]),
      "b1",
      "c1",
      "b1:paragraph, q1:paragraph, rc2:column",
      ["b1", "q1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:r)]  paragraph:z",
    ],
    ["C7", C1, "x0", "b1", "x0:paragraph, r:columnList", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["C8", AK_BQ, "b1", "z9", "b1:paragraph, q1:paragraph, z9:paragraph", ["b1", "q1", "z9"], "paragraph:x  ROW[COL(paragraph:a,paragraph:k) | COL(paragraph)]"],
    [
      "C9",
      AK_BQ,
      "a1",
      "z9",
      "a1:paragraph, k1:paragraph, rc1:column, z9:paragraph",
      ["a1", "k1", "b1", "q1", "z9"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph)]",
    ],
    ["C10", AB, "x0", "z9", "x0:paragraph, r:columnList, z9:paragraph", ["x0", "r", "z9"], "paragraph"],
    ["C11", C11, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    [
      "C12",
      TWO_ROWS,
      "b1",
      "c1",
      "b1:paragraph, m1:paragraph, s:columnList",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
];

describe("blockIdsInSelectionForDelete: expansion table", () => {
  it.each<Sd1Row>(SD1)("%s", (_name, content, from, to, blocks, ids, after) => {
    const editor = mount(content());
    const before = shape(editor);
    editor.setSelection(from, to);
    // Pinned fact: core's cross-column selection list (the first thing to go red when core is upgraded).
    expect(blocksOf(editor)).toBe(blocks);
    const got = blockIdsInSelectionForDelete(editor, editor.getSelection()!.blocks);
    expect(got).toEqual(ids);
    expect(() => removeBlocksKeepColumns(editor, got)).not.toThrow();
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });
});

// "One undo restores" must also hold under the collab UndoManager (the app's real configuration); four shapes are picked, with expectations verbatim the same as non-collab.
describe("expansion table, four shapes under collab: same deletion result, one manager.undo() returns to the start", () => {
  const COLLAB = SD1.filter(([name]) => ["C1", "C7", "C10", "C12"].includes(name));
  it("the picked ones are exactly the four shapes (renaming mustn't silently run fewer)", () => {
    expect(COLLAB.map(([name]) => name)).toEqual(["C1", "C7", "C10", "C12"]);
  });

  it.each<Sd1Row>(COLLAB)("%s (collab)", (_name, content, from, to, blocks, ids, after) => {
    const m = mountEditor(content(), { collab: true });
    cleanups.push(m.destroy);
    const editor = m.editor;
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    const before = shape(editor);
    editor.setSelection(from, to);
    expect(blocksOf(editor)).toBe(blocks);
    const got = blockIdsInSelectionForDelete(editor, editor.getSelection()!.blocks);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    manager.undo();
    expect(shape(editor)).toBe(before);
  });
});

describe("no column/row entries: unchanged", () => {
  it("returns the id string of blocks as is, order unchanged", () => {
    const editor = mount(W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]));
    editor.setSelection("a1", "k1");
    const blocks = editor.getSelection()!.blocks;
    expect(blockIdsInSelectionForDelete(editor, blocks)).toEqual(blocks.map((b) => b.id));
    expect(blockIdsInSelectionForDelete(editor, blocks)).toEqual(["a1", "k1"]);
  });
});

describe("blockIdsForMenuDelete: menu table", () => {
  const sel = (from: string, to: string) => (editor: AnyEditor) => editor.setSelection(from, to);
  it.each<[string, () => PartialBlockLike[], (editor: AnyEditor) => void, string, string[], string]>([
    ["AB: select a-b, click b", AB, sel("a1", "b1"), "b1", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z"],
    ["C1: select a-b, click b", C1, sel("a1", "b1"), "b1", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["C1: select a-b, click q (outside the selection)", C1, sel("a1", "b1"), "q1", ["q1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z"],
    ["C1: select x-b, click a (inside the selection)", C1, sel("x0", "b1"), "a1", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["C1: select x-b, click b", C1, sel("x0", "b1"), "b1", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["C4: select b-c, click c", C4, sel("b1", "c1"), "c1", ["b1", "c1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph)]  paragraph:z"],
    ["AB: select x-z, click a", AB, sel("x0", "z9"), "a1", ["x0", "r", "z9"], "paragraph"],
    ["AB: select x-z, click x", AB, sel("x0", "z9"), "x0", ["x0", "r", "z9"], "paragraph"],
    ["C11: select a-b, click the child k", C11, sel("a1", "b1"), "k1", ["k1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:q)]  paragraph:z"],
    ["first character of bb selected, click the child k", BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  paragraph:bb{paragraph:q}  paragraph:z"],
    ["select a-b, click the child k", A_BK, sel("a1", "b1"), "k1", ["k1"], "paragraph:a  paragraph:b  paragraph:z"],
    [
      "TWO_ROWS: select b-c, click b",
      TWO_ROWS,
      sel("b1", "c1"),
      "b1",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
    [
      "TWO_ROWS: select b-c, click c",
      TWO_ROWS,
      sel("b1", "c1"),
      "c1",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
    [
      "TWO_ROWS: select b-c, click d",
      TWO_ROWS,
      sel("b1", "c1"),
      "d1",
      ["d1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:m  ROW[COL(paragraph:c) | COL(paragraph)]  paragraph:z",
    ],
  ])("%s", (_name, content, select, clicked, ids, after) => {
    const editor = mount(content());
    const before = shape(editor);
    select(editor);
    const got = blockIdsForMenuDelete(editor, clicked);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });

  // Function contract: the drag handle only opens on a blockContainer (core `getDraggableBlockFromElement`), so the UI can't open one on a column node; the whole-row handle would use it.
  it("clicked id is a column node among blocks (core's original condition; function contract, not reachable from the UI) -> the expanded set", () => {
    const editor = mount(C1());
    editor.setSelection("a1", "b1");
    expect(blockIdsForMenuDelete(editor, "rc1")).toEqual(["a1", "b1"]);
  });

  it("no selection (caret inside b) -> deletes only the clicked block", () => {
    const editor = mount(AB());
    editor.setTextCursorPosition("b1", "end");
    expect(editor.getSelection()).toBeUndefined();
    expect(blockIdsForMenuDelete(editor, "a1")).toEqual(["a1"]);
  });
});

describe("invariant: with no column/row entries in the selection the rules are identical to core's", () => {
  it.each<[string, () => PartialBlockLike[], (editor: AnyEditor) => void, string, string[], string]>([
    ["BB_KQ: first character of bb selected, click the child k", BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  paragraph:bb{paragraph:q}  paragraph:z"],
    ["A_BK: select a-b, click the child k", A_BK, (editor) => editor.setSelection("a1", "b1"), "k1", ["k1"], "paragraph:a  paragraph:b  paragraph:z"],
    ["ROW_BB_KQ: first character of bb selected, click the child k", ROW_BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bb{paragraph:q})]  paragraph:z"],
    ["BB_KQ: first character of bb selected, click the child q", BB_KQ, selectFirstCharOfBb, "q1", ["q1"], "paragraph:x  paragraph:bb{paragraph:k}  paragraph:z"],
    // Multi-select branch: the clicked block is in the selection -> delete the whole selection.
    ["top-level a-b selected, click a", () => [P("a", "a1"), P("b", "b1"), P("c", "c1")], (editor) => editor.setSelection("a1", "b1"), "a1", ["a1", "b1"], "paragraph:c"],
    [
      "a and k of one column selected, click k",
      () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]),
      (editor) => editor.setSelection("a1", "k1"),
      "k1",
      ["a1", "k1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph:b)]  paragraph:z",
    ],
  ])("%s", (_name, content, select, clicked, ids, after) => {
    const editor = mount(content());
    select(editor);
    const selected = editor.getSelection()!.blocks;
    expect(selected.filter((b) => b.type === COLUMN_TYPE || b.type === COLUMN_LIST_TYPE)).toEqual([]);
    const core = selected.some((b) => b.id === clicked) ? selected.map((b) => b.id) : [clicked];
    const got = blockIdsForMenuDelete(editor, clicked);
    expect(got).toEqual(core);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
  });
});
