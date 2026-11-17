import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { editorHasBlockWithType } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";
import { createTestEditor, placeCursor, renderAiHost, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { P, textPos } from "@/test/columns-fixtures";
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
  it("applyBlockType：段落換成 H1，表格與程式碼區塊不變", () => {
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

  it("applyBlockType：目標區塊全是項目類型時全部換", () => {
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

  it("currentBlockTypeIndex：游標在表格儲存格回 -1；在段落回段落那項的索引", () => {
    const editor = mount([P("alice", "a"), TABLE]);
    const items = blockTypeItemsFor(editor);
    placeCursor(editor, "a", 1);
    const index = currentBlockTypeIndex(editor, items);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(items[index]!.type).toBe("paragraph");
    act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
    expect(currentBlockTypeIndex(editor, items)).toBe(-1);
  });

  it("blockTypeItemsFor：項目順序與名稱同 blockTypeSelectItems 依 schema 過濾的結果", () => {
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
