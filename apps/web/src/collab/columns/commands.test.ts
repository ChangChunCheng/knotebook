import { afterEach, describe, expect, it } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { P, cursorOf, integrity, mountEditor, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { canInsertColumns, insertColumns, isInColumn, ungroupColumns } from "./commands";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[], opts?: { collab?: boolean }): AnyEditor {
  const m = mountEditor(content, { collab: opts?.collab });
  cleanups.push(m.destroy);
  return m.editor;
}

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
const typeAtEnd = (editor: AnyEditor, id: string, text: string) => {
  editor.setTextCursorPosition(id, "end");
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(text));
};

describe("insertColumns", () => {
  it("insert into an empty paragraph -> replaced by a new 3-column row, each column width 1, caret at the start of the first column's paragraph", () => {
    const editor = mount([P("x", "x0"), P("", "e0"), P("z", "z0")]);
    editor.setTextCursorPosition("e0", "start");
    const id = insertColumns(editor, 3);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph)]  paragraph:z");
    const rowBlock = editor.document[1]!;
    expect(rowBlock.id).toBe(id);
    expect(rowBlock.children.map((c) => (c.props as { width: number }).width)).toEqual([1, 1, 1]);
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(editor.getTextCursorPosition().block.id).toBe(rowBlock.children[0]!.children[0]!.id);
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("caret in a non-empty paragraph -> new row inserted after it", () => {
    const editor = mount([P("x", "x0"), P("y", "y0"), P("z", "z0")]);
    editor.setTextCursorPosition("y0", "end");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("new row becomes the last block -> an empty paragraph is added after it (both insert and replace)", () => {
    const a = mount([P("x", "x0")]);
    a.setTextCursorPosition("x0", "end");
    insertColumns(a, 2);
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph");
    expect(integrity(a)).toEqual(CLEAN);

    const b = mount([P("x", "x0"), P("", "e0")]);
    b.setTextCursorPosition("e0", "start");
    insertColumns(b, 4);
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph) | COL(paragraph)]  paragraph");
    expect(integrity(b)).toEqual(CLEAN);
  });

  it("empty paragraph with child blocks -> not replaced (so the children don't vanish), new row inserted after", () => {
    const editor = mount([P("x", "x0"), withChildren(P("", "e0"), [P("k", "k0")]), P("z", "z0")]);
    editor.setTextCursorPosition("e0", "start");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph{paragraph:k}  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  it("one undo (collab): typing without stopCapturing then creating a row, one undo removes only the row, the text stays", () => {
    const editor = mount([P("x", "x0"), P("y", "y0"), P("z", "z0")], { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    typeAtEnd(editor, "y0", "Q");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ  paragraph:z");
  });
});

describe("canInsertColumns", () => {
  it("top-level paragraph true; inside a column, child block, top-level table cell false", () => {
    const editor = mount([
      P("x", "x0"),
      row([[P("a", "a1")], [P("b", "b1")]], "r"),
      withChildren(P("p", "p0"), [P("k", "k0")]),
      { id: "t0", type: "table", content: { type: "tableContent", rows: [{ cells: ["cell"] }] } } as PartialBlockLike,
      P("z", "z0"),
    ]);
    editor.setTextCursorPosition("x0", "end");
    expect(canInsertColumns(editor)).toBe(true);
    editor.setTextCursorPosition("b1", "end");
    expect(canInsertColumns(editor)).toBe(false);
    editor.setTextCursorPosition("k0", "end");
    expect(canInsertColumns(editor)).toBe(false);
    editor._tiptapEditor.commands.setTextSelection(textPos(editor, "cell", 1));
    expect(editor.getTextCursorPosition().block.type).toBe("table");
    expect(canInsertColumns(editor)).toBe(false);
  });
});

describe("ungroupColumns", () => {
  it("order = all of column 1, all of column 2, ...; empty paragraphs dropped, caret at the start of the first kept block", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1"), P("", "e1")], [P("", "e2")], [P("b", "b1"), P("c", "c1")]], "r"), P("z", "z0")]);
    expect(isInColumn(editor, "b1")).toBe(true);
    expect(ungroupColumns(editor, "b1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:c  paragraph:z");
    expect(cursorOf(editor)).toBe("a@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("with two blocks in column 1 it finishes column 1 first (not interleaved row by row)", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"), P("z", "z0")]);
    expect(ungroupColumns(editor, "a1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:q  paragraph:b  paragraph:z");
  });

  it("all-empty row -> one empty paragraph left", () => {
    const editor = mount([P("x", "x0"), row([[P("", "e1")], [P("", "e2")]], "r"), P("z", "z0")]);
    expect(ungroupColumns(editor, "e2")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph  paragraph:z");
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("row is the only block and all empty -> one empty paragraph left", () => {
    const editor = mount([row([[P("", "e1")], [P("", "e2")]], "r")]);
    expect(ungroupColumns(editor, "e1")).toBe(true);
    expect(shape(editor)).toBe("paragraph");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("child blocks of blocks inside columns are kept", () => {
    const editor = mount([row([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]], "r")]);
    expect(ungroupColumns(editor, "a1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:a{paragraph:k}  paragraph:b");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("block not inside a column -> returns false, document unchanged", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), withChildren(P("p", "p0"), [P("k", "k0")])]);
    const before = shape(editor);
    expect(isInColumn(editor, "x0")).toBe(false);
    expect(ungroupColumns(editor, "x0")).toBe(false);
    expect(ungroupColumns(editor, "k0")).toBe(false);
    expect(shape(editor)).toBe(before);
  });

  it("one undo (collab): typing without stopCapturing then ungrouping, one undo returns to the original row, the text stays", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z0")], { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    typeAtEnd(editor, "b1", "Q");
    expect(ungroupColumns(editor, "b1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:bQ  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bQ)]  paragraph:z");
  });
});
