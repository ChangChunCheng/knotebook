import { afterEach, describe, expect, it } from "vitest";
import { Extension, InputRule } from "@tiptap/core";
import { collabUndoManager } from "@/collab/undo";
import { CB, H, IMG, P, cursorOf, integrity, mountEditor, pressKey, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { createColumnEdgeKeymapExtension } from "./edge-keymap";

// Keys are always real keydown events (pressKey), not commands.keyboardShortcut().

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[], opts?: { collab?: boolean; extra?: unknown[] }): AnyEditor {
  const m = mountEditor(content, { collab: opts?.collab, extensions: (editorRef) => [createColumnEdgeKeymapExtension({ editorRef }), ...(opts?.extra ?? [])] });
  cleanups.push(m.destroy);
  return m.editor;
}

const X = () => P("x", "x0");
const Z = () => P("z", "z9");
const W = (cols: PartialBlockLike[][]): PartialBlockLike[] => [X(), row(cols, "r"), Z()];
const E = (id: string) => P("", id);

type Act = (editor: AnyEditor) => unknown;
const bs = (id: string): Act => (editor) => {
  editor.setTextCursorPosition(id, "start");
  return pressKey(editor, "Backspace");
};
const del = (id: string): Act => (editor) => {
  editor.setTextCursorPosition(id, "end");
  return pressKey(editor, "Delete");
};
const moveKey = (id: string, key: "ArrowUp" | "ArrowDown"): Act => (editor) => {
  editor.setTextCursorPosition(id, "start");
  return pressKey(editor, key, { ctrlKey: true, shiftKey: true });
};
const select = (editor: AnyEditor, w1: string, o1: number, w2: string, o2: number) =>
  editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, w1, o1), to: textPos(editor, w2, o2) });
// Browser default input: when no plugin takes over handleTextInput, insert as plain text.
const typeText = (editor: AnyEditor, text: string) => {
  const view = editor.prosemirrorView!;
  const { from, to } = view.state.selection;
  const deflt = () => view.state.tr.insertText(text, from, to);
  if (!view.someProp("handleTextInput", (f) => f(view, from, to, text, deflt))) view.dispatch(deflt());
};

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

// cursor null = not asserted.
const TABLE: [string, () => PartialBlockLike[], Act, string, string | null][] = [
  ["Backspace at start of column 2 in [a|b]", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "b@0"],
  ["Backspace at start of column 2 in [a|b|empty]", () => W([[P("a", "a1")], [P("b", "b1")], [E("e3")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph)]  paragraph:z", "b@0"],
  ["Backspace at start of column 2 in [a|b|c]", () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c)]  paragraph:z", "b@0"],
  [
    "Backspace at start of column 2 (two blocks) in [a|b,q|c]",
    () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")], [P("c", "c1")]]),
    bs("b1"),
    "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:q) | COL(paragraph:c)]  paragraph:z",
    "b@0",
  ],
  [
    "Backspace at start of column 3 in [a|empty|b,q]",
    () => W([[P("a", "a1")], [E("e2")], [P("b", "b1"), P("q", "q1")]]),
    bs("b1"),
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:q)]  paragraph:z",
    "b@0",
  ],
  ["Delete at end of column 1 in [a|b]", () => W([[P("a", "a1")], [P("b", "b1")]]), del("a1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "a@1"],
  ["Delete at end of column 1 in [a|b|c]", () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["Delete at end of column 1 in [a|b,q]", () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:q)]  paragraph:z", "a@1"],
  ["Delete at end of column 1 in [a|empty|c]", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["Delete at end of the last block (q) of column 1 in [a,q|b]", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("q1"), "paragraph:x  paragraph:a  paragraph:q  paragraph:b  paragraph:z", "q@1"],
  ["Delete at end of column 1 in [a|empty,q]", () => W([[P("a", "a1")], [E("e2"), P("q", "q1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph) | COL(paragraph:q)]  paragraph:z", "a@1"],
  ["Delete at end of the last column, block z after the row", () => W([[P("a", "a1")], [P("b", "b1")]]), del("b1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]", "z@0"],
  ["Delete at end of the last column, row at document end", () => [X(), row([[P("a", "a1")], [P("b", "b1")]], "r")], del("b1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]", "b@1"],
  ["Backspace at start of a heading in column 2", () => W([[P("a", "a1")], [H("h", "h1")]]), bs("h1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:h)]  paragraph:z", "h@0"],
  ["Backspace at start of block b that has a child, in column 2", () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")])]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b{paragraph:k}  paragraph:z", "b@0"],
  // Backspace at the start of a child block of a column block isn't column start: handed back to core (k becomes a sibling of b).
  ["Backspace at start of the child k of b in column 2", () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")])]]), bs("k1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:k)]  paragraph:z", "k@0"],
  // The following four cases aren't column start/end: handed back to core (guarding the position condition for column start/end). The two mid-text cases (Backspace in column 2, Delete in column 1) have no keymap in PM (native browser delete) and jsdom has no native behaviour, so the document is unchanged.
  ["Backspace at start of the second block q of column 2", () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]), bs("q1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bq)]  paragraph:z", "bq@1"],
  ["Delete at end of block a (not last) in column 1 of [a,q|b]", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:aq) | COL(paragraph:b)]  paragraph:z", "aq@1"],
  [
    "Backspace in the middle of text in column 2",
    () => W([[P("a", "a1")], [P("bb", "b1")]]),
    (editor) => {
      editor._tiptapEditor.commands.setTextSelection(textPos(editor, "bb", 1));
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bb)]  paragraph:z",
    "bb@1",
  ],
  [
    "Delete in the middle of text in column 1",
    () => W([[P("aa", "a1")], [P("b", "b1")]]),
    (editor) => {
      editor._tiptapEditor.commands.setTextSelection(textPos(editor, "aa", 1));
      return pressKey(editor, "Delete");
    },
    "paragraph:x  ROW[COL(paragraph:aa) | COL(paragraph:b)]  paragraph:z",
    "aa@1",
  ],
  ["Delete at end of a block with a child in column 1", () => W([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:ak) | COL(paragraph:b)]  paragraph:z", "ak@1"],
  ["Backspace in empty column 2 of [a|empty]", () => W([[P("a", "a1")], [E("e2")]]), bs("e2"), "paragraph:x  paragraph:a  paragraph:z", "a@1"],
  ["Backspace in empty column 2 of [a|empty|c]", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), bs("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["Backspace in empty column 1 of [empty|b]", () => W([[E("e1")], [P("b", "b1")]]), bs("e1"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["Backspace in empty column 1 of [empty|b], row first in the document", () => [row([[E("e1")], [P("b", "b1")]], "r"), Z()], bs("e1"), "paragraph:b  paragraph:z", "b@0"],
  ["Backspace in empty last column of [a|empty|empty]", () => W([[P("a", "a1")], [E("e2")], [E("e3")]]), bs("e3"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z", "paragraph@0"],
  ["Backspace in empty column 2 of [empty|empty]", () => W([[E("e1")], [E("e2")]]), bs("e2"), "paragraph:x  paragraph  paragraph:z", "paragraph@0"],
  ["Backspace in empty column 2 of [image|empty]", () => W([[IMG("i1", 300)], [E("e2")]]), bs("e2"), "paragraph:x  image  paragraph:z", "image@0"],
  // After collapsing a column the caret target is an image (not a textblock): the image itself is selected, rather than jumping below the row.
  ["Backspace in empty column 1 of [empty|image]", () => W([[E("e1")], [IMG("i1", 300)]]), bs("e1"), "paragraph:x  image  paragraph:z", "image@0"],
  ["Delete in empty column 1 of [empty|image]", () => W([[E("e1")], [IMG("i1", 300)]]), del("e1"), "paragraph:x  image  paragraph:z", "image@0"],
  ["Backspace at start of column 2 in [image|b]", () => W([[IMG("i1", 300)], [P("b", "b1")]]), bs("b1"), "paragraph:x  image  paragraph:b  paragraph:z", "b@0"],
  ["Delete at end of column 1 in [a|image]", () => W([[P("a", "a1")], [IMG("i1", 300)]]), del("a1"), "paragraph:x  paragraph:a  image  paragraph:z", "a@1"],
  ["Delete at end of column 1 in [a|empty]", () => W([[P("a", "a1")], [E("e2")]]), del("a1"), "paragraph:x  paragraph:a  paragraph:z", "a@1"],
  ["Delete in empty column 1 of [empty|b]", () => W([[E("e1")], [P("b", "b1")]]), del("e1"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["Delete in empty column 1 of [empty|b,q]", () => W([[E("e1")], [P("b", "b1"), P("q", "q1")]]), del("e1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q)]  paragraph:z", "b@0"],
  ["Backspace at start of column 2 in [empty|b,q]", () => W([[E("e1")], [P("b", "b1"), P("q", "q1")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q)]  paragraph:z", "b@0"],
  ["Backspace in empty middle column of [a|empty|empty]", () => W([[P("a", "a1")], [E("e2")], [E("e3")]]), bs("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z", "a@1"],
  ["Backspace at start of column 2 in [a|b,empty]", () => W([[P("a", "a1")], [P("b", "b1"), E("e2")]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "b@0"],
  [
    "Backspace at start of column 3 of four columns",
    () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]]),
    bs("c1"),
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:c) | COL(paragraph:d)]  paragraph:z",
    "c@0",
  ],
  ["Backspace in empty column 1 of [empty|b|c]", () => W([[E("e1")], [P("b", "b1")], [P("c", "c1")]]), bs("e1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:c)]  paragraph:z", "b@0"],
  ["Delete at end of column 1 in [a|image,b]", () => W([[P("a", "a1")], [IMG("i1", 300), P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]  paragraph:z", "a@1"],
  ["Delete in empty middle column of [a|empty|c]", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), del("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "c@0"],
  ["Delete in a code block alone in column 1 of [code|b]", () => W([[CB("cb")], [P("b", "b1")]]), del("cb"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["Delete in a code block in the last column at document end", () => [X(), row([[P("a", "a1")], [CB("cb")]], "r")], del("cb"), "paragraph:x  paragraph:a", "a@1"],
  ["Delete in a code block after a in column 1", () => W([[P("a", "a1"), CB("cb")], [P("b", "b1")]]), del("cb"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z", "b@0"],
  ["Backspace at start of column 1 in [a|b]", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("a1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", null],
  ["Delete at end of the block before the row", () => W([[P("a", "a1")], [P("b", "b1")]]), del("x0"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", null],
  ["Delete at end of the block before the row, column 1 has two blocks", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("x0"), "paragraph:x  paragraph:a  ROW[COL(paragraph:q) | COL(paragraph:b)]  paragraph:z", null],
  ["Backspace at start of the block after the row", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("z9"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]", "z@0"],
  [
    "Delete at end of the child k of a in column 1",
    () => W([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]]),
    del("k1"),
    "paragraph:x  ROW[COL(paragraph:a{paragraph:kz}) | COL(paragraph:b)]",
    "kz@1",
  ],
  ["Move block b up from column 2 (ArrowUp)", () => W([[P("a", "a1")], [P("b", "b1")]]), moveKey("b1", "ArrowUp"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph)]  paragraph:z", "b@0"],
  ["Move block a down from column 1 (ArrowDown)", () => W([[P("a", "a1")], [P("b", "b1")]]), moveKey("a1", "ArrowDown"), "paragraph:x  ROW[COL(paragraph) | COL(paragraph:a,paragraph:b)]  paragraph:z", "a@0"],
  [
    "Select across columns, Backspace",
    () => W([[P("aa", "a1")], [P("bb", "b1")], [P("cc", "c1")]]),
    (editor) => {
      select(editor, "aa", 1, "cc", 1);
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:ac) | COL(paragraph)]  paragraph:z",
    "ac@1",
  ],
  [
    "Select across columns, type text",
    () => W([[P("aa", "a1")], [P("bb", "b1")], [P("cc", "c1")]]),
    (editor) => {
      select(editor, "aa", 1, "cc", 1);
      typeText(editor, "Q");
    },
    "paragraph:x  ROW[COL(paragraph:aQc) | COL(paragraph)]  paragraph:z",
    "aQc@2",
  ],
  [
    "empty column",
    () => W([[P("a", "a1")], [P("bb", "b1")]]),
    (editor) => {
      select(editor, "bb", 0, "bb", 2);
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z",
    "paragraph@0",
  ],
];

describe("keyboard matrix (column-edge keyboard handling + core)", () => {
  it.each(TABLE)("%s", (_name, content, act, expected, cursor) => {
    const editor = mount(content());
    const before = shape(editor);
    act(editor);
    expect(shape(editor)).toBe(expected);
    if (cursor !== null) expect(cursorOf(editor)).toBe(cursor);
    expect(integrity(editor)).toEqual(CLEAN);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });

  it("empty column (continued): after selecting and deleting all of bb, Backspace at the start of the empty column -> column collapses and flattens to x a z, caret a@1; one undo returns to the start (non-collab: history merges two adjacent keys into one step; the collab configuration is covered by the collab undo describe)", () => {
    const editor = mount(W([[P("a", "a1")], [P("bb", "b1")]]));
    const before = shape(editor);
    select(editor, "bb", 0, "bb", 2);
    pressKey(editor, "Backspace");
    const mid = shape(editor);
    expect(mid).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:z");
    expect(cursorOf(editor)).toBe("a@1");
    expect(integrity(editor)).toEqual(CLEAN);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });
});

describe("row at document end, Delete at the end of the last column", () => {
  it("swallowed: pressKey returns true, no exception, document unchanged", () => {
    const editor = mount([X(), row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    const before = shape(editor);
    editor.setTextCursorPosition("b1", "end");
    let handled: boolean | undefined;
    expect(() => {
      handled = pressKey(editor, "Delete");
    }).not.toThrow();
    expect(handled).toBe(true);
    expect(shape(editor)).toBe(before);
    expect(cursorOf(editor)).toBe("b@1");
  });
});

describe("an input rule that just fired is undone by Backspace first", () => {
  const doubleGt = () =>
    Extension.create({
      name: "testDoubleGt",
      addInputRules() {
        return [
          new InputRule({
            find: /^>>$/,
            handler: ({ state, range }) => {
              state.tr.delete(range.from, range.to);
            },
          }),
        ];
      },
    });

  it("[a|empty] rule just cleared that column to an empty column -> Backspace undoes the rule giving [a|>>], no column collapse", () => {
    const editor = mount(W([[P("a", "a1")], [E("e2")]]), { extra: [doubleGt()] });
    editor.setTextCursorPosition("e2", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText(">"));
    const { from } = view.state.selection;
    expect(view.someProp("handleTextInput", (f) => f(view, from, from, ">", () => view.state.tr.insertText(">", from, from)))).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:>>)]  paragraph:z");
  });

  it("[a|empty,q] typing >> in the empty paragraph triggers the rule -> Backspace undoes the rule, no move", () => {
    const editor = mount(W([[P("a", "a1")], [E("e2"), P("q", "q1")]]), { extra: [doubleGt()] });
    editor.setTextCursorPosition("e2", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText(">"));
    const { from } = view.state.selection;
    expect(view.someProp("handleTextInput", (f) => f(view, from, from, ">", () => view.state.tr.insertText(">", from, from)))).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph,paragraph:q)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:>>,paragraph:q)]  paragraph:z");
  });
});

describe("the move done by column-edge keyboard handling is its own undo step (collab UndoManager)", () => {
  it("Backspace right after typing without stopCapturing, then typing again -> undo reverts only the later typing, the move, then the earlier typing, in order", () => {
    const editor = mount(W([[P("a", "a1")], [P("b", "b1")]]), { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    editor.setTextCursorPosition("b1", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    editor.setTextCursorPosition("b1", "start");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:Qb  paragraph:z");
    view.dispatch(view.state.tr.insertText("W"));
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:WQb  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:Qb  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:Qb)]  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  });
});

describe("selection fully spanning a whole row, then delete", () => {
  it("[xx, [aa|bb], zz] select from the middle of xx to the middle of zz -> Backspace: the row disappears, the paragraphs before and after merge as in core, document valid", () => {
    const editor = mount([P("xx", "x0"), row([[P("aa", "a1")], [P("bb", "b1")]], "r"), P("zz", "z9")]);
    select(editor, "xx", 1, "zz", 1);
    pressKey(editor, "Backspace");
    expect(shape(editor)).toBe("paragraph:xz");
    expect(shape(editor)).not.toContain("ROW");
    expect(integrity(editor)).toEqual(CLEAN);
  });
});

describe("document starting with a row, keys pressed right after mount without clicking", () => {
  it.each(["Backspace", "Delete"])("%s: selection inside a column (not a textblock) -> no error, document unchanged", (key) => {
    const editor = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), Z()], { collab: true });
    const before = shape(editor);
    expect(editor.prosemirrorView!.state.selection.$from.parent.type.name).toBe("column");
    expect(() => pressKey(editor, key)).not.toThrow();
    expect(shape(editor)).toBe(before);
  });

  it("Delete: TextSelection at the end of a table node inside a column (parent is table, not a textblock) -> column-edge keyboard handling doesn't take over, result equals core without it", () => {
    const table: PartialBlockLike = { id: "t1", type: "table", content: { type: "tableContent", rows: [{ cells: ["c1", "c2"] }] } };
    const run = (editor: AnyEditor) => {
      const view = editor.prosemirrorView!;
      const t = findTable(editor);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TextSelection is taken from the constructor of the current selection
      const Sel = view.state.selection.constructor as any;
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, t.pos + t.size - 1)));
      expect(view.state.selection.$from.parent.type.name).toBe("table");
      pressKey(editor, "Delete");
      return shape(editor);
    };
    const core = mountEditor(W([[table], [P("b", "b1")]]));
    cleanups.push(core.destroy);
    const coreShape = run(core.editor);
    expect(coreShape).toBe("paragraph:x  table  paragraph  paragraph:b  paragraph:z");
    expect(run(mount(W([[table], [P("b", "b1")]])))).toBe(coreShape);
  });
});

function findTable(editor: AnyEditor): { pos: number; size: number } {
  let hit: { pos: number; size: number } | undefined;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (node.type.name === "table") hit = { pos, size: node.nodeSize };
  });
  return hit!;
}

describe("editorRef not set yet (current is null)", () => {
  it.each([
    ["Backspace", "b1", "start", "paragraph:x  paragraph:a  paragraph  paragraph:b  paragraph:z / b@0"],
    ["Delete", "a1", "end", "paragraph:x  paragraph:a  paragraph  paragraph:b  paragraph:z / b@0"],
  ] as const)("%s: column-edge keyboard handling doesn't take over, no error, result is core's", (key, id, where, expected) => {
    const m = mountEditor(W([[P("a", "a1")], [P("b", "b1")]]), { extensions: [createColumnEdgeKeymapExtension({ editorRef: { current: null } })] });
    cleanups.push(m.destroy);
    m.editor.setTextCursorPosition(id, where);
    expect(() => pressKey(m.editor, key)).not.toThrow();
    expect(shape(m.editor) + " / " + cursorOf(m.editor)).toBe(expected);
  });
});
