import { afterEach, describe, expect, it, vi } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, mountEditor, row, type AnyEditor } from "@/test/columns-fixtures";
import { createWidthPreview, writeColumnWidths } from "./width-preview";

const mounts: { destroy(): void }[] = [];
afterEach(() => {
  while (mounts.length) mounts.pop()!.destroy();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
  vi.restoreAllMocks();
});

const mount = (content: Parameters<typeof mountEditor>[0], collab = true) => {
  const m = mountEditor(content, { collab });
  mounts.push(m);
  return m.editor;
};
const widths = (editor: AnyEditor, rowId = "r") =>
  (editor.getBlock(rowId) as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width);
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");

function countUpdates(editor: AnyEditor) {
  const doc = collabUndoManager(editor)!.doc;
  const spy = vi.fn();
  doc.on("update", spy);
  return spy;
}

describe("createWidthPreview", () => {
  it("after set head has one stylesheet, one rule per column of the whole row with the input values; none after clear", () => {
    const preview = createWidthPreview(document);
    expect(previewTables().length).toBe(0);
    preview.set({ columnIds: ["a", "b", "c"], grows: [0.5, 1.25, 1.25] });
    preview.set({ columnIds: ["a", "b", "c"], grows: [0.6, 1.2, 1.2] });
    expect(previewTables().length).toBe(1);
    const text = previewTables()[0]!.textContent!;
    expect(text.split("\n").length).toBe(3);
    expect(text).toContain('[data-id="a"] { flex-grow: 0.6 !important; }');
    expect(text).toContain('[data-id="b"] { flex-grow: 1.2 !important; }');
    expect(text).toContain('[data-id="c"] { flex-grow: 1.2 !important; }');
    preview.clear();
    expect(previewTables().length).toBe(0);
  });

  it("ids with quotes and special characters go through CSS.escape", () => {
    const preview = createWidthPreview(document);
    const id = 'a"]{x:y}';
    preview.set({ columnIds: [id], grows: [1] });
    const text = previewTables()[0]!.textContent!;
    expect(text).toContain(`[data-id="${CSS.escape(id)}"]`);
    expect(text).not.toContain(`[data-id="${id}"]`);
  });

  it("clear is idempotent: with no preview, or called twice, throws nothing and leaves no stylesheet", () => {
    const preview = createWidthPreview(document);
    expect(() => preview.clear()).not.toThrow();
    preview.set({ columnIds: ["a"], grows: [1] });
    preview.clear();
    expect(() => preview.clear()).not.toThrow();
    expect(previewTables().length).toBe(0);
  });

  it("cleanup by the caller after the editor unmounts leaves no preview stylesheet in head", () => {
    const m = mountEditor([row([[P("a")], [P("b")]], "r")], { collab: true });
    const preview = createWidthPreview(document);
    preview.set({ columnIds: ["rc0", "rc1"], grows: [1, 1] });
    m.destroy();
    preview.clear();
    expect(previewTables().length).toBe(0);
  });
});

describe("preview doesn't touch the document", () => {
  it("during set the Y.Doc gets no update and the document is unchanged; the preview reaches column elements via the stylesheet", () => {
    const m = mountEditor([row([[P("a")], [P("b")]], "r")], { collab: true });
    mounts.push(m);
    const editor = m.editor;
    const col = (id: string) => m.container.querySelector<HTMLElement>(`[data-node-type="column"][data-id="${id}"]`)!;
    const styleBefore = [col("rc0").getAttribute("style"), col("rc1").getAttribute("style")];
    const updates = countUpdates(editor);
    const before = JSON.stringify(editor.document);
    const preview = createWidthPreview(document);
    preview.set({ columnIds: ["rc0", "rc1"], grows: [0.4, 1.6] });
    expect(updates).not.toHaveBeenCalled();
    expect(JSON.stringify(editor.document)).toBe(before);
    expect([col("rc0").getAttribute("style"), col("rc1").getAttribute("style")]).toEqual(styleBefore);
    expect(getComputedStyle(col("rc0")).flexGrow).toBe("0.4");
    expect(getComputedStyle(col("rc1")).flexGrow).toBe("1.6");
    preview.clear();
  });
});

describe("writeColumnWidths", () => {
  it("updateBlock only on changed columns; undoStack grows by 1; undo restores the original values", () => {
    const editor = mount([row([[P("a")], [P("b")], [P("c")]], "r", [1, 1, 1])]);
    const manager = collabUndoManager(editor)!;
    const spy = vi.spyOn(editor, "updateBlock");
    const stack = manager.undoStack.length;
    expect(writeColumnWidths(editor, "r", [0.5, 1.5, 1])).toBe(true);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["rc0", "rc1"]);
    expect(widths(editor)).toEqual([0.5, 1.5, 1]);
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1, 1]);
  });

  it("next equal to the current values -> false, undoStack unchanged, no update", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r", [0.5, 1.5])]);
    const manager = collabUndoManager(editor)!;
    const updates = countUpdates(editor);
    const stack = manager.undoStack.length;
    expect(writeColumnWidths(editor, "r", [0.5, 1.5])).toBe(false);
    expect(manager.undoStack.length).toBe(stack);
    expect(updates).not.toHaveBeenCalled();
  });

  it("id is not a column row (a paragraph) -> false, no stopCapturing, no update", () => {
    const editor = mount([P("x", "p0"), row([[P("a")], [P("b")]], "r")]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "p0", [1, 1])).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  it("row missing or column count differs -> false, nothing written", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r")]);
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "nope", [1, 1])).toBe(false);
    expect(writeColumnWidths(editor, "r", [1, 1, 1])).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("previewWidth written in the same update", () => {
  it("column widths and previewWidth in one Y update; one undo restores both", () => {
    const editor = mount([row([[IMG("i", 300)], [P("b")]], "r", [1, 1])]);
    const manager = collabUndoManager(editor)!;
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "r", [1.5, 0.5], { previewWidth: { blockId: "i", value: 500 } })).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(widths(editor)).toEqual([1.5, 0.5]);
    expect((editor.getBlock("i") as unknown as { props: { previewWidth: number } }).props.previewWidth).toBe(500);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1]);
    expect((editor.getBlock("i") as unknown as { props: { previewWidth: number } }).props.previewWidth).toBe(300);
  });
});

describe("undo step splitting", () => {
  it("by default stopCapturing once before and once after; undoStep:false doesn't call it", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r")]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    writeColumnWidths(editor, "r", [0.5, 1.5]);
    expect(stop).toHaveBeenCalledTimes(2);
    stop.mockClear();
    writeColumnWidths(editor, "r", [0.6, 1.4], { undoStep: false });
    expect(stop).not.toHaveBeenCalled();
  });

  it("undoStep:false called twice adds one step and one undo goes back to before both; by default two calls add two steps", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r", [1, 1])]);
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    const stack = manager.undoStack.length;
    writeColumnWidths(editor, "r", [0.9, 1.1], { undoStep: false });
    writeColumnWidths(editor, "r", [0.8, 1.2], { undoStep: false });
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1]);

    manager.stopCapturing();
    const stack2 = manager.undoStack.length;
    writeColumnWidths(editor, "r", [0.9, 1.1]);
    writeColumnWidths(editor, "r", [0.8, 1.2]);
    expect(manager.undoStack.length).toBe(stack2 + 2);
  });
});

describe("since: columns changed by others during the operation", () => {
  it("columns other than own whose current value no longer equals base -> not written, current value kept; the two own columns are written per next", () => {
    const editor = mount([row([[P("a")], [P("b")], [P("c")]], "r", [1.2, 0.8, 1])]);
    const spy = vi.spyOn(editor, "updateBlock");
    expect(writeColumnWidths(editor, "r", [1, 1.2, 0.8], { since: { base: [1, 1, 1], own: [1, 2] } })).toBe(true);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["rc1", "rc2"]);
    expect(widths(editor)).toEqual([1.2, 1.2, 0.8]);
  });

  it("columns other than own whose current value still equals base -> written per next (a row whose sum isn't the column count is normalized as a whole)", () => {
    const editor = mount([row([[P("a")], [P("b")], [P("c")]], "r", [0.6, 0.6, 0.6])]);
    expect(writeColumnWidths(editor, "r", [1.2, 0.8, 1], { since: { base: [0.6, 0.6, 0.6], own: [0, 1] } })).toBe(true);
    expect(widths(editor)).toEqual([1.2, 0.8, 1]);
  });

  it("only columns other than own differ and were changed by others -> nothing to write, returns false, no update", () => {
    const editor = mount([row([[P("a")], [P("b")], [P("c")]], "r", [1.2, 0.8, 1])]);
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "r", [1, 0.8, 1], { since: { base: [1, 0.8, 1], own: [1, 2] } })).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });
});
