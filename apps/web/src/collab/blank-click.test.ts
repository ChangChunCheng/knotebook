/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view/selection directly (types unavailable in apps/web) */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CB, IMG, P, blockPos, mountEditor, type AnyEditor } from "@/test/columns-fixtures";
import { clearNodeSelectionAt, type BlankClickView } from "@/collab/blank-click";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const mounted = mountEditor([P("alpha", "p1"), IMG("i1"), CB("c1", "const x = 1;"), P("omega", "p2")]);
  cleanups.push(() => mounted.destroy());
  return mounted.editor;
}

/** jsdom has no layout: posAtCoords and the editor rects are faked, fixing an editor range of top 100 / bottom 500. */
function viewOf(editor: AnyEditor, hitPos: number | null): BlankClickView {
  const view = editor.prosemirrorView! as any;
  view.dom.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 50, right: 450, width: 400, height: 400, x: 50, y: 100, toJSON() {} });
  view.posAtCoords = vi.fn(() => (hitPos === null ? null : { pos: hitPos }));
  view.focus = vi.fn();
  return view;
}

/** Builds a NodeSelection at `pos` via `fromJSON({ type: "node" })` (apps/web can't get prosemirror-state values). */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(view.state.selection.node, "前提：NodeSelection").toBeDefined();
}

const kind = (editor: AnyEditor) => (editor.prosemirrorView!.state.selection as any).node === undefined ? "text" : "node";

describe("clearNodeSelectionAt", () => {
  it("image selected, click blank space inside the editor range -> replaced by a caret, focus given to the editor", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "p2") + 2);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(view.focus).toHaveBeenCalledTimes(1);
    // The blank area's x is clamped into the editor range before looking up the position.
    expect((view.posAtCoords as any).mock.calls[0][0]).toEqual({ left: 51, top: 300 });
  });

  it("code block selected -> likewise replaced by a caret", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "c1") + 1);
    const view = viewOf(editor, blockPos(editor, "p1") + 2);
    expect(clearNodeSelectionAt(view, { x: 500, y: 200 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect((view.posAtCoords as any).mock.calls[0][0].left).toBe(449);
  });

  it("below the editor's bottom edge -> caret at document end (end of the last paragraph)", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, null);
    expect(clearNodeSelectionAt(view, { x: 200, y: 900 }, true)).toBe(true);
    const sel = editor.prosemirrorView!.state.selection;
    expect(kind(editor)).toBe("text");
    expect(sel.from).toBe(sel.to);
    expect(sel.$head.parent.textContent).toBe("omega");
    expect(sel.$head.parentOffset).toBe("omega".length);
  });

  it("above the editor's top edge -> caret at document start", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "c1") + 1);
    const view = viewOf(editor, null);
    expect(clearNodeSelectionAt(view, { x: 200, y: 10 }, true)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.$head.parent.textContent).toBe("alpha");
  });

  it("read-only (focus=false) only swaps the selection, doesn't take focus", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "p1") + 2);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, false)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("click lands on the image itself (the first selectable afterwards is the image) still doesn't yield a NodeSelection again", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "i1") + 1);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
  });

  it("image is the document's last block: click below the editor's bottom edge -> caret lands at the last text position before it", () => {
    const mounted = mountEditor([P("alpha", "p1"), IMG("i1")]);
    cleanups.push(() => mounted.destroy());
    const editor = mounted.editor;
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, null);
    expect(clearNodeSelectionAt(view, { x: 200, y: 900 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(editor.prosemirrorView!.state.selection.$head.parent.textContent).toBe("alpha");
  });

  it("currently a text caret -> does nothing (no dispatch, no focus)", () => {
    const editor = setup();
    editor.setTextCursorPosition("p1", "end");
    const view = viewOf(editor, blockPos(editor, "p2") + 2);
    const before = editor.prosemirrorView!.state.selection.from;
    const dispatch = vi.spyOn(view, "dispatch");
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, true)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.focus).not.toHaveBeenCalled();
    expect(editor.prosemirrorView!.state.selection.from).toBe(before);
  });
});
