/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection（型別在 apps/web 拿不到） */
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

/** jsdom 沒有版面：posAtCoords 與編輯器的矩形都換成假的，固定一個編輯器範圍 top 100／bottom 500。 */
function viewOf(editor: AnyEditor, hitPos: number | null): BlankClickView {
  const view = editor.prosemirrorView! as any;
  view.dom.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 50, right: 450, width: 400, height: 400, x: 50, y: 100, toJSON() {} });
  view.posAtCoords = vi.fn(() => (hitPos === null ? null : { pos: hitPos }));
  view.focus = vi.fn();
  return view;
}

/** 以 `fromJSON({ type: "node" })` 在 `pos` 建 NodeSelection（apps/web 拿不到 prosemirror-state 的值）。 */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(view.state.selection.node, "前提：NodeSelection").toBeDefined();
}

const kind = (editor: AnyEditor) => (editor.prosemirrorView!.state.selection as any).node === undefined ? "text" : "node";

describe("clearNodeSelectionAt", () => {
  it("圖片被選取、點編輯器範圍內的空白 → 換成游標、焦點交給編輯器", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "p2") + 2);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(view.focus).toHaveBeenCalledTimes(1);
    // 左邊空地的 x 被夾進編輯器範圍再查位置。
    expect((view.posAtCoords as any).mock.calls[0][0]).toEqual({ left: 51, top: 300 });
  });

  it("程式碼區塊被選取 → 同樣換成游標", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "c1") + 1);
    const view = viewOf(editor, blockPos(editor, "p1") + 2);
    expect(clearNodeSelectionAt(view, { x: 500, y: 200 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect((view.posAtCoords as any).mock.calls[0][0].left).toBe(449);
  });

  it("編輯器下緣之下 → 游標在文件結尾（最後一段的尾端）", () => {
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

  it("編輯器上緣之上 → 游標在文件開頭", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "c1") + 1);
    const view = viewOf(editor, null);
    expect(clearNodeSelectionAt(view, { x: 200, y: 10 }, true)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.$head.parent.textContent).toBe("alpha");
  });

  it("唯讀（focus=false）只換 selection、不取焦點", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "p1") + 2);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, false)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("點擊位置落在圖片本身（之後第一個選得到的是圖片）也不會再得到 NodeSelection", () => {
    const editor = setup();
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, blockPos(editor, "i1") + 1);
    expect(clearNodeSelectionAt(view, { x: 10, y: 300 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
  });

  it("圖片是文件最後一個 block：點編輯器下緣之下 → 游標落在它前面最後一個文字位置", () => {
    const mounted = mountEditor([P("alpha", "p1"), IMG("i1")]);
    cleanups.push(() => mounted.destroy());
    const editor = mounted.editor;
    selectNode(editor, blockPos(editor, "i1") + 1);
    const view = viewOf(editor, null);
    expect(clearNodeSelectionAt(view, { x: 200, y: 900 }, true)).toBe(true);
    expect(kind(editor)).toBe("text");
    expect(editor.prosemirrorView!.state.selection.$head.parent.textContent).toBe("alpha");
  });

  it("目前是文字游標 → 什麼都不做（不 dispatch、不取焦點）", () => {
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
