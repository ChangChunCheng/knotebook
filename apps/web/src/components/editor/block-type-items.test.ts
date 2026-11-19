import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { editorHasBlockWithType } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";
import { createTestEditor, placeCursor, renderAiHost, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { collabUndoManager } from "@/collab/undo";
import { P, mountEditor, textPos } from "@/test/columns-fixtures";
import { applyBlockType, blockTypeItemsFor, currentBlockTypeIndex, targetBlocks } from "./block-type-items";

const TABLE = { id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: ["x", "y"] }, { cells: ["z", "w"] }] } } as never;
const CODE = { id: "c", type: "codeBlock", content: "line1\nline2" } as never;

function mount(doc: unknown[]): AnyEditor {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [] });
  renderAiHost({ editor, children: null });
  return editor;
}

describe("block-type-items", () => {
  it("applyBlockType: turns a paragraph into H1, leaving table and code block unchanged", () => {
    const editor = mount([P("alice", "a"), P("bob", "b"), TABLE, CODE]);
    const items = blockTypeItemsFor(editor);
    const h1 = items.find((item) => item.type === "heading" && item.props?.level === 1)!;
    selectWholeBlocks(editor, "a", "c");
    expect(targetBlocks(editor).map((block) => block.type)).toEqual(["paragraph", "paragraph", "table", "codeBlock"]);
    const tableBefore = JSON.stringify(editor.getBlock("t")!.content);
    const codeBefore = JSON.stringify(editor.getBlock("c")!.content);

    act(() => applyBlockType(editor, h1, items));

    for (const id of ["a", "b"]) {
      const block = editor.getBlock(id)!;
      expect(block.type).toBe("heading");
      expect((block.props as { level: number }).level).toBe(1);
    }
    expect(editor.getBlock("t")!.type).toBe("table");
    expect(JSON.stringify(editor.getBlock("t")!.content)).toBe(tableBefore);
    expect((editor.getBlock("t")!.content as { rows: unknown[] }).rows).toEqual(
      (JSON.parse(tableBefore) as { rows: unknown[] }).rows,
    );
    expect(editor.getBlock("c")!.type).toBe("codeBlock");
    expect(JSON.stringify(editor.getBlock("c")!.content)).toBe(codeBefore);
  });

  it("applyBlockType: converts all targets when all are item types", () => {
    const editor = mount([P("alice", "a"), P("bob", "b"), P("carol", "c")]);
    const items = blockTypeItemsFor(editor);
    const h2 = items.find((item) => item.type === "heading" && item.props?.level === 2)!;
    selectWholeBlocks(editor, "a", "c");

    act(() => applyBlockType(editor, h2, items));

    for (const id of ["a", "b", "c"]) {
      const block = editor.getBlock(id)!;
      expect(block.type).toBe("heading");
      expect((block.props as { level: number }).level).toBe(2);
    }
  });

  it("currentBlockTypeIndex: returns -1 with the caret in a table cell; with the caret in a paragraph returns the paragraph item's index", () => {
    const editor = mount([P("alice", "a"), TABLE]);
    const items = blockTypeItemsFor(editor);
    placeCursor(editor, "a", 1);
    const index = currentBlockTypeIndex(editor, items);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(items[index]!.type).toBe("paragraph");
    act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
    expect(currentBlockTypeIndex(editor, items)).toBe(-1);
  });

  it("blockTypeItemsFor: item order and names equal blockTypeSelectItems filtered by schema", () => {
    const editor = mount([P("alice", "a")]);
    const expected = blockTypeSelectItems(editor.dictionary).filter((item) =>
      editorHasBlockWithType(
        editor,
        item.type,
        Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as Record<string, "string" | "number" | "boolean">,
      ),
    );
    const actual = blockTypeItemsFor(editor);
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.map((item) => [item.type, item.name])).toEqual(expected.map((item) => [item.type, item.name]));
  });
});

describe("applyBlockType undo step (collaboration)", () => {
  it("changing type right after typing: the type change is its own step, one undo reverts only the type and the typed text stays", () => {
    const cleanups: (() => void)[] = [];
    const m = mountEditor([P("alice", "a"), P("bob", "b")], { collab: true });
    cleanups.push(m.destroy);
    const editor = m.editor;
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    editor.setTextCursorPosition("a", "end");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    const items = blockTypeItemsFor(editor);
    const h1 = items.find((item) => item.type === "heading" && item.props?.level === 1)!;
    act(() => applyBlockType(editor, h1, items));
    expect(editor.getBlock("a")!.type).toBe("heading");
    manager.undo();
    expect(editor.getBlock("a")!.type).toBe("paragraph");
    expect(JSON.stringify(editor.getBlock("a")!.content)).toContain("aliceQ");
    cleanups.forEach((fn) => fn());
  });
});
