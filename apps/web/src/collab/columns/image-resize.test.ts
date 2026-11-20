import { afterEach, describe, expect, it, vi } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, mountEditor, row, shape, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { expandColumnPixels, ratiosFromPixels } from "./widths";

// Column image handles: dragging within the image's usable width changes only the image; beyond it squeezes other columns (deducted in proportion to each column's headroom above its minimum width); on release image width and column widths are written together, one undo step.

/** The full-size capture element the native handle inserts into the wrapper on press (core `createResizableFileBlockWrapper`'s eventCaptureElement). */
const CAPTURE = ":scope > div[style*='position: absolute']";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
});

function mount(content: PartialBlockLike[], collab = false) {
  const mounted = mountEditor(content, { collab });
  cleanups.push(mounted.destroy);
  return mounted;
}

/**
 * jsdom has no layout, so measurements are returned by identity:
 * - `ck`: block id -> `clientWidth` of that block's content box (`.bn-block-content`), i.e. the image's usable width;
 * - `columns`: column id -> the column's pixel width (`getBoundingClientRect().width`) and `clientWidth`;
 * - `rows`: row id -> the row's `clientWidth` (the cap when stacked).
 * Once a column's width is written to the document PM replaces the column element, so the mock is attached to the prototype and looks up by `data-id`; elements not found fall through to the original implementation.
 */
interface Geometry {
  ck?: Record<string, number>;
  columns?: Record<string, number>;
  rows?: Record<string, number>;
}
function mockGeometry({ ck = {}, columns = {}, rows = {} }: Geometry) {
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.getAttribute("data-node-type") === "column" ? columns[this.getAttribute("data-id") ?? ""] : undefined;
    return w === undefined ? rect.call(this) : new DOMRect(0, 0, w, 100);
  });
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-id") ?? "";
    const type = this.getAttribute("data-node-type");
    let w: number | undefined;
    if (this.classList.contains("bn-block-content")) w = ck[this.closest(".bn-block-outer")?.getAttribute("data-id") ?? ""];
    else if (type === "column") w = columns[id];
    else if (type === "columnList") w = rows[id];
    return w === undefined ? clientWidth.call(this) : w;
  });
}

/**
 * The wrapper and left/right handles of image `id`. Default measurements: image usable width 200, display width 200 (previewWidth 300 squeezed to the usable width by max-width), two columns of 200px each (the text columns are already at minimum width).
 */
function imageParts(container: HTMLElement, id: string, displayed = 200, geometry: Geometry = {}) {
  mockGeometry({ ck: { [id]: 200 }, columns: { rc0: 200, rc1: 200 }, ...geometry });
  const outer = container.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`)!;
  const wrapper = outer.querySelector<HTMLElement>(".bn-file-block-content-wrapper")!;
  const [left, right] = Array.from(wrapper.querySelectorAll<HTMLElement>(".bn-resize-handle"));
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, displayed, 100));
  return { wrapper, left, right };
}

const down = (el: Element, clientX: number) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX }));
// mousemove is dispatched on window directly (bubbling through document would wake core SideMenu's mousemove, which needs elementsFromPoint that jsdom lacks); mouseup is dispatched on the element and bubbles to window like the real thing (the native window mouseup handler uses target for `wrapper.contains`).
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const up = (clientX: number) => document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX }));
const previewWidth = (editor: AnyEditor, id: string) => (editor.getBlock(id)!.props as { previewWidth?: number }).previewWidth;
const widths = (editor: AnyEditor, rowId = "r") =>
  (editor.getBlock(rowId) as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width);
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");
const previewGrow = (columnId: string) => {
  const text = previewTables()[0]?.textContent ?? "";
  const m = new RegExp(`\\[data-id="${columnId}"\\] \\{ flex-grow: ([0-9.]+) !important; \\}`).exec(text);
  return m ? Number(m[1]) : null;
};

function countUpdates(editor: AnyEditor) {
  const spy = vi.fn();
  collabUndoManager(editor)!.doc.on("update", spy);
  return spy;
}

const inColumn = (alignment?: string, columnWidths?: number[]) => [
  P("x", "x0"),
  row(
    [[{ ...IMG("i1", 300), ...(alignment ? { props: { ...IMG("i1", 300).props, textAlignment: alignment } } : {}) }], [P("b", "b1")]],
    "r",
    columnWidths,
  ),
  P("z", "z9"),
];

describe("column image handles", () => {
  it("right handle: intercepts the native one (no capture element, browser default cancelled); +100 beyond the usable width 200 -> text columns give up 100px; on release previewWidth 300 and the text column ratio shrinks; moves after release no longer change width or write", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 } });
    const before = wrapper.querySelectorAll(CAPTURE).length;
    expect(down(right, 500)).toBe(false); // dispatchEvent returns false when preventDefault'ed
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before);
    move(600);
    expect(wrapper.style.width).toBe("300px");
    expect([previewGrow("rc0"), previewGrow("rc1")]).toEqual([1, 1]);
    up(600);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([1, 1]);
    expect(previewTables().length).toBe(0);
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    move(400);
    expect(wrapper.style.width).toBe("300px");
    up(400);
    expect(onChange).not.toHaveBeenCalled();
    expect(previewWidth(editor, "i1")).toBe(300);
  });

  it("one resize is its own undo step (collab): typing without stopCapturing then dragging the image, one undo restores only the width, the text stays", () => {
    const { editor, container } = mount(inColumn(), true);
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    editor.setTextCursorPosition("b1", "end");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    const { right } = imageParts(container, "i1");
    down(right, 500);
    move(450);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
    manager.undo();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(image) | COL(paragraph:bQ)]  paragraph:z");
  });

  it("right handle dragged left by 50 -> width shrinks, on release previewWidth is an integer (display width 200.6 -> 150.6px -> 151)", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1", 200.6);
    down(right, 500);
    move(450);
    expect(wrapper.style.width).toBe("150.6px");
    up(450);
    expect(previewWidth(editor, "i1")).toBe(151);
  });

  it("lower bound same as native 64px (dragging left by 1000)", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 1500);
    move(500);
    expect(wrapper.style.width).toBe("64px");
    up(500);
    expect(previewWidth(editor, "i1")).toBe(64);
  });

  it("left handle dragged right by 50 -> 150px (left-side displacement reversed)", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, left } = imageParts(container, "i1");
    down(left, 100);
    move(150);
    expect(wrapper.style.width).toBe("150px");
    up(150);
    expect(previewWidth(editor, "i1")).toBe(150);
  });

  it("centered image: displacement doubled (right handle -30 -> 140px)", () => {
    const { editor, container } = mount(inColumn("center"));
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 500);
    move(470);
    expect(wrapper.style.width).toBe("140px");
    up(470);
    expect(previewWidth(editor, "i1")).toBe(140);
  });

  it("a click without displacement -> no write, no new transaction", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    const before = wrapper.style.width;
    down(right, 500);
    move(500);
    up(500);
    expect(wrapper.style.width).toBe(before);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("top-level (not in a column) image: not intercepted, native still inserts the capture element", () => {
    const { container } = mount([P("x", "x0"), IMG("i0", 300), P("z", "z9")]);
    const { wrapper, right } = imageParts(container, "i0");
    const before = wrapper.querySelectorAll(CAPTURE).length;
    down(right, 500);
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before + 1);
    up(500);
  });

  it("read-only (isEditable=false): column handle doesn't intercept", () => {
    const { editor, container } = mount(inColumn());
    editor.isEditable = false;
    const { wrapper, right } = imageParts(container, "i1");
    const before = wrapper.querySelectorAll(CAPTURE).length;
    down(right, 500);
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before + 1);
    up(500);
  });
});

/** [image|text|text] at 200/400/300 px, matching the document ratios; the text columns have headroom 200 and 100. */
const threeColumns = () => [
  P("x", "x0"),
  row([[IMG("i1", 300)], [P("b", "b1")], [P("c", "c1")]], "r", [0.67, 1.33, 1]),
  P("z", "z9"),
];
const THREE_PX = { rc0: 200, rc1: 400, rc2: 300 };

describe("column image column expansion", () => {
  it("beyond the usable width: other columns give up space in proportion to headroom; on release previewWidth = round(W) and column widths are one Y update, one undo restores both", () => {
    const { editor, container } = mount(threeColumns(), true);
    const manager = collabUndoManager(editor)!;
    const { wrapper, right } = imageParts(container, "i1", 200.4, { columns: THREE_PX });
    const updates = countUpdates(editor);
    down(right, 500);
    move(650);
    expect(wrapper.style.width).toBe("350.4px");
    const expected = expandColumnPixels([200, 400, 300], [96, 200, 200], 0, 150.4);
    expect(expected.granted).toBe(150.4);
    // The two text columns give way 2:1, in proportion to their headroom.
    expect(400 - expected.px[1]!).toBeCloseTo(2 * (300 - expected.px[2]!), 9);
    const next = ratiosFromPixels(expected.px);
    expect(next).toEqual([1.17, 1, 0.83]);
    expect([previewGrow("rc0"), previewGrow("rc1"), previewGrow("rc2")]).toEqual(next);
    expect(updates).not.toHaveBeenCalled();
    up(650);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(previewWidth(editor, "i1")).toBe(350);
    expect(widths(editor)).toEqual(next);
    expect(previewTables().length).toBe(0);
    manager.undo();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("pulled larger then back within the usable width: the preview table is removed, release writes only previewWidth, column widths unchanged", () => {
    const { editor, container } = mount(threeColumns());
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(600);
    expect(previewTables().length).toBe(1);
    move(480);
    expect(wrapper.style.width).toBe("180px");
    expect(previewTables().length).toBe(0);
    up(480);
    expect(previewWidth(editor, "i1")).toBe(180);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("exceeds by only 1px: computed column ratios equal the document's current values after rounding, release still writes previewWidth, column widths unchanged", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(501);
    expect(ratiosFromPixels(expandColumnPixels([200, 400, 300], [96, 200, 200], 0, 1).px)).toEqual([0.67, 1.33, 1]);
    up(501);
    expect(previewWidth(editor, "i1")).toBe(201);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("another column is also an image column: yields down to the image column's minimum width 96 (gives up 104px)", () => {
    const { editor, container } = mount([P("x", "x0"), row([[IMG("i1", 300)], [IMG("i3", 300)]], "r", [1, 1]), P("z", "z9")]);
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 200 } });
    down(right, 500);
    move(700);
    expect(wrapper.style.width).toBe("304px");
    up(700);
    expect(previewWidth(editor, "i1")).toBe(304);
    expect(widths(editor)).toEqual(ratiosFromPixels([304, 96]));
  });

  it("all other columns at minimum width: width stops at the usable width, columns unchanged, no preview table", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 500);
    move(600);
    expect(wrapper.style.width).toBe("200px");
    expect(previewTables().length).toBe(0);
    up(600);
    expect(previewWidth(editor, "i1")).toBe(200);
    expect(widths(editor)).toEqual([1, 1]);
  });

  it("cap 4000: usable width 3000 + text column headroom 1800 could reach 4800, still stops at 4000, text columns give up only 1000px", () => {
    const { editor, container } = mount(inColumn(undefined, [1.2, 0.8]));
    const { wrapper, right } = imageParts(container, "i1", 3000, { ck: { i1: 3000 }, columns: { rc0: 3000, rc1: 2000 } });
    down(right, 500);
    move(5500);
    expect(wrapper.style.width).toBe("4000px");
    up(5500);
    expect(previewWidth(editor, "i1")).toBe(4000);
    expect(widths(editor)).toEqual(ratiosFromPixels([4000, 1000]));
    expect(widths(editor)).toEqual([1.6, 0.4]);
  });

  it("shrinking never changes columns (even when a text column has headroom)", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(450);
    expect(wrapper.style.width).toBe("150px");
    expect(previewTables().length).toBe(0);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("stacked row: the cap is the row width, columns untouched", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    container.querySelector('[data-node-type="columnList"]')!.setAttribute("data-stacked", "");
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 }, rows: { r: 300 } });
    down(right, 500);
    move(1000);
    expect(wrapper.style.width).toBe("300px");
    expect(previewTables().length).toBe(0);
    up(1000);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("image inside an indented child block: usable width is that block's content box (40px narrower than the column), exceeding it starts expanding columns", () => {
    const content = [P("x", "x0"), row([[withChildren(P("t", "t1"), [IMG("i2", 300)])], [P("b", "b1")]], "r", [1, 2]), P("z", "z9")];
    const { editor, container } = mount(content);
    const { wrapper, right } = imageParts(container, "i2", 150, { ck: { i2: 160 }, columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(530);
    expect(wrapper.style.width).toBe("180px");
    up(530);
    expect(previewWidth(editor, "i2")).toBe(180);
    expect(widths(editor)).toEqual(ratiosFromPixels(expandColumnPixels([200, 400], [200, 200], 0, 20).px));
    expect(widths(editor)).toEqual([0.73, 1.27]);
  });
});

describe("column image drag cancel and release", () => {
  it("Esc during drag: nothing written, preview table removed, image width back to before the press; later moves and release have no effect", () => {
    const { editor, container } = mount(threeColumns());
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    const styleBefore = wrapper.style.width;
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    down(right, 500);
    move(650);
    expect(previewTables().length).toBe(1);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(previewTables().length).toBe(0);
    expect(wrapper.style.width).toBe(styleBefore);
    move(700);
    up(700);
    expect(onChange).not.toHaveBeenCalled();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("the column id sequence of the row changes mid-drag (the other end deleted a column): cancelled, nothing written", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(650);
    editor.removeBlocks(["rc2"]);
    expect(previewTables().length).toBe(0);
    const before = JSON.stringify(editor.document);
    move(700);
    up(700);
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(previewWidth(editor, "i1")).toBe(300);
  });

  it("image deleted mid-drag (row unchanged): cancelled, release throws nothing, nothing written", () => {
    const content = [P("x", "x0"), row([[withChildren(P("t", "t1"), [IMG("i2", 300)])], [P("b", "b1")]], "r", [1, 2]), P("z", "z9")];
    const { editor, container } = mount(content);
    const { right } = imageParts(container, "i2", 150, { ck: { i2: 160 }, columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    editor.removeBlocks(["i2"]);
    expect(previewTables().length).toBe(0);
    const before = JSON.stringify(editor.document);
    // An exception thrown by an event listener doesn't propagate out of dispatchEvent; jsdom fires an error event on window instead.
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    cleanups.push(() => window.removeEventListener("error", onError));
    up(560);
    expect(errors).toEqual([]);
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("editor unmounts mid-drag: preview table removed, later release writes nothing", () => {
    const mounted = mountEditor(threeColumns());
    const { right } = imageParts(mounted.container, "i1", 200, { columns: THREE_PX });
    const write = vi.spyOn(mounted.editor, "updateBlock");
    down(right, 500);
    move(650);
    expect(previewTables().length).toBe(1);
    mounted.destroy();
    expect(previewTables().length).toBe(0);
    up(700);
    expect(write).not.toHaveBeenCalled();
  });

  it("becomes read-only mid-drag: release writes nothing, preview table removed", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(650);
    editor.isEditable = false;
    up(650);
    expect(previewTables().length).toBe(0);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("the position of the release event counts too: with no mousemove, releasing directly at -50 -> previewWidth 150", () => {
    const { editor, container } = mount(inColumn());
    const { right } = imageParts(container, "i1");
    down(right, 500);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
  });
});
