import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { COLUMN_TYPE, YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { COLUMN_GAP_PX } from "@/collab/columns/layout";
import { STACKED_ATTR } from "@/collab/columns/layout-extension";
import { writeColumnWidths } from "@/collab/columns/width-preview";
import { ratiosFromPixels } from "@/collab/columns/widths";
import { IMG, P, mountEditor, row, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { ColumnDividers } from "./ColumnDividers";
import { DRAG_ACTIVE_CLASS } from "./use-drag-active-class";

/**
 * Manually triggerable ResizeObserver stand-in (same as `layout-extension.test.ts`): `fire(el)` first asserts el is observed, then calls every RO
 * observing it - firing on an element that was never observed would make a missing-observe wiring bug pass vacuously. The layout extension (stacking) uses the same stand-in.
 */
const observed = new Set<Element>();
let instances: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    instances.push(this);
  }
  observe(target: Element) {
    observed.add(target);
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    if (!instances.some((ro) => ro.targets.has(target))) observed.delete(target);
  }
  disconnect() {
    for (const t of [...this.targets]) this.unobserve(t);
  }
}
function fire(el: Element) {
  expect(observed.has(el)).toBe(true);
  act(() => {
    for (const ro of instances) {
      if (ro.targets.has(el)) ro.callback([{ target: el } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver);
    }
  });
}

/** Animation frames are advanced manually by the test: position and measurements coalesce into the next frame and are visible only after `flushFrames()`. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flushFrames() {
  act(() => {
    while (frames.size) {
      const batch = [...frames.values()];
      frames = new Map();
      for (const cb of batch) cb(0);
    }
  });
}

/**
 * jsdom has no layout: rect values depend on identity. PM replaces the column element whenever a column width changes, so the mock sits on the prototype
 * and recomputes from the current document value (looked up by `data-id`) on every rect read: each column's px = `w_i / sum(w) * (row width - total gutter)`,
 * then per flex min-width, columns below the minimum are pinned at it and the rest share the remaining width proportionally.
 * `fixed` gives a row's per-column pixel widths directly (ignoring the document).
 */
interface Layout {
  left: number;
  top: number;
  rowWidth: number;
  rowHeight: number;
  rowTops: Record<string, number>;
  fixed: Record<string, number[]>;
}
let layout: Layout;
let columnEl: HTMLElement;
let editorUnderTest: AnyEditor;

const MIN_TEXT = 200;
function flexPx(widths: readonly number[], available: number): number[] {
  const px: (number | null)[] = widths.map(() => null);
  for (;;) {
    const free = widths.map((_, i) => i).filter((i) => px[i] === null);
    const used = px.reduce<number>((a, b) => a + (b ?? 0), 0);
    const grow = free.reduce((a, i) => a + widths[i]!, 0);
    const share = free.map((i) => ((available - used) * widths[i]!) / grow);
    const under = free.filter((_, k) => share[k]! < MIN_TEXT);
    if (under.length === 0) {
      free.forEach((i, k) => (px[i] = share[k]!));
      return px as number[];
    }
    for (const i of under) px[i] = MIN_TEXT;
  }
}
function docWidths(rowId: string): number[] {
  const block = editorUnderTest.getBlock(rowId) as unknown as { children: { props: { width: number } }[] };
  return block.children.map((c) => c.props.width);
}
function columnPx(rowId: string): number[] {
  if (layout.fixed[rowId]) return layout.fixed[rowId]!;
  const widths = docWidths(rowId);
  return flexPx(widths, layout.rowWidth - COLUMN_GAP_PX * (widths.length - 1));
}
const rowTop = (rowId: string) => layout.top + (layout.rowTops[rowId] ?? 100);

function mockLayout(partial: Partial<Layout> = {}) {
  layout = { left: 40, top: 10, rowWidth: 1024, rowHeight: 120, rowTops: {}, fixed: {}, ...partial };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === columnEl) return new DOMRect(layout.left, layout.top, layout.rowWidth, 3000);
    const type = this.getAttribute("data-node-type");
    if (type === "columnList") return new DOMRect(layout.left, rowTop(this.getAttribute("data-id")!), layout.rowWidth, layout.rowHeight);
    if (type === COLUMN_TYPE) {
      const rowEl = this.parentElement!;
      const rowId = rowEl.getAttribute("data-id")!;
      const k = Array.from(rowEl.children).indexOf(this);
      const px = columnPx(rowId);
      const x = layout.left + px.slice(0, k).reduce((a, b) => a + b, 0) + COLUMN_GAP_PX * k;
      return new DOMRect(x, rowTop(rowId), px[k]!, layout.rowHeight);
    }
    return new DOMRect(0, 0, 0, 0);
  });
}

const cleanups: (() => void)[] = [];

beforeAll(() => {
  // jsdom has no pointer capture.
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
});
beforeEach(async () => {
  await i18n.changeLanguage("en");
  observed.clear();
  instances = [];
  frames = new Map();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  document.body.style.userSelect = "";
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Mounts a collaborative editor into `columnEl` (the dividers' container); the overlay renders inside the same `columnEl` (same as on the note page).
 * `editable: false` makes the editor read-only before render.
 */
function setup(
  content: PartialBlockLike[],
  opts: { editable?: boolean; layout?: Partial<Layout>; beforeRender?: () => void } = {},
) {
  columnEl = document.createElement("div");
  document.body.appendChild(columnEl);
  const m = mountEditor(content, { collab: true });
  editorUnderTest = m.editor;
  columnEl.appendChild(m.container);
  const host = document.createElement("div");
  columnEl.appendChild(host);
  mockLayout(opts.layout);
  if (opts.editable === false) m.editor.isEditable = false;
  opts.beforeRender?.();
  const view = render(<ColumnDividers container={columnEl} editor={m.editor} />, { container: host });
  cleanups.push(() => {
    view.unmount();
    m.destroy();
    columnEl.remove();
  });
  flushFrames();
  const editor = m.editor;
  const rowEl = (rowId: string) => editor.domElement!.querySelector<HTMLElement>(`[data-node-type="columnList"][data-id="${rowId}"]`)!;
  const separators = (rowId?: string) =>
    Array.from(columnEl.querySelectorAll<HTMLElement>('[role="separator"]')).filter((s) => !rowId || s.dataset.rowId === rowId);
  const columnOf = (id: string) => editor.domElement!.querySelector<HTMLElement>(`[data-node-type="column"][data-id="${id}"]`)!;
  return { editor, host, unmount: view.unmount, rowEl, separators, columnOf, viewDom: editor.domElement! };
}

const widths = docWidths;
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");
/** `[column id, grow]` of each row of the preview table. */
function previewRows(): [string, number][] {
  const text = previewTables()[0]!.textContent!;
  return text.split("\n").map((line) => {
    const m = /\[data-id="([^"]+)"\] \{ flex-grow: ([\d.]+) !important; \}/.exec(line)!;
    return [m[1]!, Number(m[2])];
  });
}

function countUpdates(editor: AnyEditor) {
  const doc = collabUndoManager(editor)!.doc;
  const spy = vi.fn();
  doc.on("update", spy);
  cleanups.push(() => doc.off("update", spy));
  return spy;
}

const down = (sep: HTMLElement, clientX = 500) => fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX });
const move = (clientX: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX });
const up = (clientX: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX });

const twoCols = (id = "r", w?: number[]) => row([[P("a")], [P("b")]], id, w);
const threeCols = (id = "s", w?: number[]) => row([[P("a")], [P("b")], [P("c")]], id, w);

describe("rendering", () => {
  it("a two-column row has one divider, a three-column row two; aria and labels", () => {
    const { separators } = setup([twoCols(), P("x"), threeCols()]);
    expect(separators("r").length).toBe(1);
    expect(separators("s").length).toBe(2);
    const sep = separators("r")[0]!;
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-label")).toBe("Resize columns");
    expect(sep.tabIndex).toBe(0);
    expect(sep.dataset.index).toBe("0");
    expect(separators("s").map((s) => s.dataset.index)).toEqual(["0", "1"]);
    expect(sep.closest(".kb-column-dividers")).not.toBeNull();
  });

  it("a row that becomes stacked (data-stacked) has no divider", () => {
    const { separators, rowEl } = setup([twoCols(), threeCols()]);
    expect(separators("r").length).toBe(1);
    Object.defineProperty(rowEl("r"), "clientWidth", { value: 300, configurable: true });
    fire(rowEl("r"));
    expect(rowEl("r").hasAttribute(STACKED_ATTR)).toBe(true);
    flushFrames();
    expect(separators("r").length).toBe(0);
    expect(separators("s").length).toBe(2);
  });

  it("read-only: no dividers", () => {
    const { separators } = setup([twoCols(), threeCols()], { editable: false });
    expect(separators().length).toBe(0);
  });
});

describe("pointer drag", () => {
  it("while moving only the preview table changes (one line per column of the row, no Y update); release writes once as one undo step with values equal to the preview column by column; a row whose sum is not the column count is normalized as a whole", () => {
    // Three columns of 0.6 each (sum 1.8 != 3), shown at equal 400px each; drag the first divider.
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");
    const { editor, separators, columnOf } = setup([threeCols("s", [0.6, 0.6, 0.6])], { layout: { rowWidth: 1248 } });
    const updates = countUpdates(editor);
    const manager = collabUndoManager(editor)!;
    const stack = manager.undoStack.length;
    const sep = separators("s")[0]!;
    // The default action of mousedown (moving focus to the divider, starting text selection) is cancelled; pointer events still start the drag and capture.
    expect(fireEvent.mouseDown(sep)).toBe(false);
    down(sep, 500);
    expect(capture).toHaveBeenCalledTimes(1);
    for (const d of [50, 100, 150]) move(500 + d);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(1);
    const rows = previewRows();
    expect(rows.map(([id]) => id)).toEqual(["sc0", "sc1", "sc2"]);
    const grows = rows.map(([, g]) => g);
    expect(grows).toEqual(ratiosFromPixels([550, 250, 400], [0, 1]));
    expect(grows[2]).toBe(1);
    // The preview reaches the column elements through a stylesheet; the columns' own inline style is untouched.
    expect(["sc0", "sc1", "sc2"].map((id) => Number(getComputedStyle(columnOf(id)).flexGrow))).toEqual(grows);
    expect(columnOf("sc0").getAttribute("style")).toMatch(/flex:\s*0\.6 1 0/);
    up(650);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(widths("s")).toEqual(grows);
    expect(previewTables().length).toBe(0);
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths("s")).toEqual([0.6, 0.6, 0.6]);
  });

  it("when the release position was never reported by a pointermove, writes at the release position", () => {
    const { separators } = setup([twoCols()]);
    down(separators("r")[0]!, 500);
    move(520);
    up(560);
    expect(widths("r")).toEqual(ratiosFromPixels([560, 440], [0, 1]));
    expect(widths("r")).toEqual([1.12, 0.88]);
    expect(previewTables().length).toBe(0);
  });

  it("pointercancel during a drag cancels: the preview table disappears, user-select is restored, a later release writes nothing", () => {
    const { editor, separators } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    up(600);
    expect(updates).not.toHaveBeenCalled();
    expect(widths("r")).toEqual([1, 1]);
  });

  it("a click without movement writes nothing and leaves no preview table", () => {
    const { editor, separators } = setup([twoCols("r", [0.6, 1.4])]);
    const updates = countUpdates(editor);
    const sep = separators("r")[0]!;
    down(sep, 500);
    up(500);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([0.6, 1.4]);
  });

  it("Esc during a drag cancels: the preview table disappears and a later release writes nothing", () => {
    const { editor, separators } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    move(600);
    up(600);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([1, 1]);
  });
});

describe("aria range when the two columns have different minimum widths", () => {
  it("[image, text] (minimum 96/200): aria-valuemin follows the left column's 96, aria-valuemax the right column's 200", () => {
    const { separators } = setup([row([[IMG("i")], [P("b")]], "r")], { layout: { fixed: { r: [300, 700] } } });
    const sep = separators("r")[0]!;
    const total = 300 + 700;
    expect(sep.getAttribute("aria-valuenow")).toBe(String(Math.round((300 / total) * 100)));
    expect(sep.getAttribute("aria-valuemin")).toBe(String(Math.round((96 / total) * 100)));
    expect(sep.getAttribute("aria-valuemax")).toBe(String(Math.round(((total - 200) / total) * 100)));
    expect([sep.getAttribute("aria-valuemin"), sep.getAttribute("aria-valuemax")]).toEqual(["10", "80"]);
  });
});

describe("minimum width and changing only the two adjacent columns", () => {
  it("stops at the minimum width: [300,300] dragged left by 500 writes [200,400]", () => {
    const { separators } = setup([twoCols()], { layout: { rowWidth: 624 } });
    down(separators("r")[0]!, 500);
    move(0);
    up(0);
    expect(widths("r")).toEqual(ratiosFromPixels([200, 400], [0, 1]));
    expect(widths("r")).toEqual([0.67, 1.33]);
  });

  it.each([
    [30, [0.61, 0.51]],
    [-50, [0.47, 0.65]],
  ] as const)("rounding remainder lands only on the two dragged columns: [0.56, 0.56, 1.88] shown as [300,300,1001], dragging the first divider by %i leaves column 3 untouched", (d, expected) => {
    const px = [300 + d, 300 - d, 1001];
    // Precondition: after rounding each column, the sum is not 300 (there is a rounding remainder to distribute).
    const sum = px.map((p) => Math.round(((3 * p) / 1601) * 100)).reduce((a, b) => a + b, 0);
    expect(sum).not.toBe(300);
    const { editor, separators } = setup([threeCols("r", [0.56, 0.56, 1.88])], {
      layout: { rowWidth: 1601 + 2 * COLUMN_GAP_PX, fixed: { r: [300, 300, 1001] } },
    });
    const update = vi.spyOn(editor, "updateBlock");
    down(separators("r")[0]!, 500);
    move(500 + d);
    up(500 + d);
    expect(widths("r")).toEqual([...expected, 1.88]);
    expect(update.mock.calls.map((c) => c[0])).not.toContain("rc2");
  });
});

describe("keyboard", () => {
  it("two quick presses make one undo step and one undo returns to before both; each moves 5% of the available width (50px); aria 50 -> 55 -> 60, min/max 20/80", () => {
    const { editor, separators } = setup([twoCols()]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    expect([sep.getAttribute("aria-valuenow"), sep.getAttribute("aria-valuemin"), sep.getAttribute("aria-valuemax")]).toEqual(["50", "20", "80"]);
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    const pxOfLeft = () => (widths("r")[0]! / 2) * (1024 - COLUMN_GAP_PX);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(pxOfLeft()).toBeCloseTo(550, 6);
    flushFrames();
    expect(separators("r")[0]!.getAttribute("aria-valuenow")).toBe("55");
    fireEvent.keyDown(separators("r")[0]!, { key: "ArrowRight" });
    expect(pxOfLeft()).toBeCloseTo(600, 6);
    flushFrames();
    expect(separators("r")[0]!.getAttribute("aria-valuenow")).toBe("60");
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths("r")).toEqual([1, 1]);
  });

  it("slow presses (the gap exceeds the merge window) make two undo steps", async () => {
    const { editor, separators } = setup([twoCols()]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    // UndoManager decides merging with the native Date.now bound by lib0, which fake timers cannot replace, so the test really waits.
    await new Promise((r) => setTimeout(r, 600));
    flushFrames();
    fireEvent.keyDown(separators("r")[0]!, { key: "ArrowLeft" });
    expect(widths("r")).toEqual([0.8, 1.2]);
    expect(manager.undoStack.length).toBe(stack + 2);
  });

  it("focus and blur each start a new undo step; consecutive presses do not", () => {
    const { editor, separators } = setup([twoCols()]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    const sep = separators("r")[0]!;
    act(() => sep.focus());
    expect(stop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => sep.blur());
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

/** Another client: a second editor on the same Y state; `push()` sends its changes to the editor under test, `pull()` the reverse. */
async function remotePeer(editor: AnyEditor) {
  const docA = collabUndoManager(editor)!.doc;
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const peer = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: docB.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u2", name: "User 2", color: "hsl(200 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  peer.mount(el);
  cleanups.push(() => {
    peer.unmount();
    el.remove();
    docB.destroy();
  });
  await new Promise((r) => setTimeout(r, 50));
  return {
    peer,
    push: () => act(() => Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))),
    pull: () => act(() => Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))),
  };
}

describe("remote edits to the row during a drag", () => {
  it("remote deletes the whole row: release writes nothing, the preview table disappears", async () => {
    const { editor, separators } = setup([P("x", "x0"), twoCols()]);
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    peer.removeBlocks(["r"]);
    push();
    expect(editor.getBlock("r")).toBeUndefined();
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
  });

  it("remote adds a column (the column id sequence changes): release writes nothing, the preview table disappears", async () => {
    const { editor, separators } = setup([twoCols()]);
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    peer.insertBlocks([{ type: COLUMN_TYPE, props: { width: 1 }, children: [P("n")] }] as never, "rc1", "after");
    push();
    expect((editor.getBlock("r") as unknown as { children: unknown[] }).children.length).toBe(3);
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r").slice(0, 2)).toEqual([1, 1]);
  });

  it("after pressing the 2nd divider, a remote changes the 1st and syncs in: on release column 1 keeps the remote value and only the two columns beside the divider are written per the drag result", async () => {
    // Three columns of 400px each, document [1,1,1].
    const { editor, separators } = setup([threeCols("r")], { layout: { rowWidth: 1248 } });
    const { peer, push, pull } = await remotePeer(editor);
    const manager = collabUndoManager(editor)!;
    const stack = manager.undoStack.length;
    down(separators("r")[1]!, 500);
    move(540);
    expect(writeColumnWidths(peer, "r", [1.2, 0.8, 1])).toBe(true);
    push();
    flushFrames();
    expect(widths("r")).toEqual([1.2, 0.8, 1]);
    expect(previewTables().length).toBe(1);
    const update = vi.spyOn(editor, "updateBlock");
    up(580);
    expect(ratiosFromPixels([400, 480, 320], [1, 2])).toEqual([1, 1.2, 0.8]);
    expect(widths("r")).toEqual([1.2, 1.2, 0.8]);
    expect(update.mock.calls.map((c) => c[0])).toEqual(["rc1", "rc2"]);
    expect(manager.undoStack.length).toBe(stack + 1);
    expect(previewTables().length).toBe(0);
    pull();
    expect((peer.getBlock("r") as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width)).toEqual([1.2, 1.2, 0.8]);
  });

  it("remote replaces a column with a new one (same count, id sequence changes): release writes nothing, the preview table disappears", async () => {
    const { editor, separators } = setup([threeCols("r")], { layout: { rowWidth: 1248 } });
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    peer.transact(() => {
      peer.insertBlocks([{ id: "rnew", type: COLUMN_TYPE, props: { width: 1 }, children: [P("n")] }] as never, "rc2", "after");
      peer.removeBlocks(["rc2"]);
    });
    push();
    expect((editor.getBlock("r") as unknown as { children: { id: string }[] }).children.map((c) => c.id)).toEqual(["rc0", "rc1", "rnew"]);
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([1, 1, 1]);
  });
});

describe("dividers do not take the pointer during a drag-and-drop", () => {
  /** Extracts the rules containing `.kb-dragging` from index.css verbatim (same as `use-drag-active-class.test.tsx`). */
  const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");
  function dragRules(): string {
    const out: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (selectors.includes(`.${DRAG_ACTIVE_CLASS}`)) out.push(`${selectors} {${m[2]}}`);
    }
    return out.join("\n");
  }

  it("with kb-dragging on the column, each divider itself (carrying pointer-events-auto) computes to none; removing it returns to auto", () => {
    // jsdom does not load Tailwind: inject the effect of the two utilities so the divider really carries an explicit auto (closing only the outer element would let it still take the pointer).
    const style = document.createElement("style");
    style.textContent = `.pointer-events-none { pointer-events: none; }\n.pointer-events-auto { pointer-events: auto; }\n${dragRules()}`;
    document.head.appendChild(style);
    cleanups.push(() => style.remove());
    const { separators } = setup([twoCols(), threeCols()]);
    const all = separators();
    expect(all.length).toBe(3);
    const pe = () => all.flatMap((s) => [s, ...Array.from(s.querySelectorAll<HTMLElement>("*"))]).map((el) => getComputedStyle(el).pointerEvents);
    expect(pe().every((v) => v === "auto")).toBe(true);
    columnEl.classList.add(DRAG_ACTIVE_CLASS);
    expect(pe().every((v) => v === "none")).toBe(true);
    columnEl.classList.remove(DRAG_ACTIVE_CLASS);
    expect(pe().every((v) => v === "auto")).toBe(true);
  });
});

describe("position tracking", () => {
  it("content above the row grows and pushes the row down (document unchanged): the view.dom RO fires and the dividers follow", () => {
    const { separators, viewDom } = setup([P("x", "x0"), twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.top).toBe("100px");
    expect(sep.style.left).toBe(`${(1024 - COLUMN_GAP_PX) / 2}px`);
    layout.rowTops.r = 340;
    fire(viewDom);
    flushFrames();
    expect(separators("r")[0]!.style.top).toBe("340px");
    expect(separators("r")[0]!.style.left).toBe(`${(1024 - COLUMN_GAP_PX) / 2}px`);
  });

  it("layout changed with no RO firing: pointerenter re-measures and updates the position", () => {
    const { separators } = setup([P("x", "x0"), twoCols()]);
    layout.rowTops.r = 260;
    expect(separators("r")[0]!.style.top).toBe("100px");
    fireEvent.pointerEnter(separators("r")[0]!);
    expect(separators("r")[0]!.style.top).toBe("260px");
  });

  it("when the position is stale, pointerdown only updates the position and does not start a drag; pressing again at the right position starts it", () => {
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");
    const { separators } = setup([P("x", "x0"), twoCols()]);
    layout.rowTops.r = 260;
    down(separators("r")[0]!, 500);
    expect(capture).not.toHaveBeenCalled();
    expect(separators("r")[0]!.style.top).toBe("260px");
    move(560);
    expect(previewTables().length).toBe(0);
    up(560);
    down(separators("r")[0]!, 500);
    expect(capture).toHaveBeenCalledTimes(1);
    move(560);
    expect(previewTables().length).toBe(1);
    up(560);
  });

  it("does not listen to scroll", () => {
    // The editor's own listeners do not count: the spy is installed after the editor is mounted and before the divider overlay renders; the event delegation React installs on the render root container (including scroll) does not count either.
    let add: ReturnType<typeof vi.spyOn> | undefined;
    let onWindow: ReturnType<typeof vi.spyOn> | undefined;
    const { separators, host } = setup([twoCols()], {
      beforeRender: () => {
        add = vi.spyOn(EventTarget.prototype, "addEventListener");
        onWindow = vi.spyOn(window, "addEventListener");
      },
    });
    fireEvent.pointerEnter(separators("r")[0]!);
    down(separators("r")[0]!, 500);
    move(520);
    up(520);
    const types = [...add!.mock.calls.filter((_, i) => add!.mock.contexts[i] !== host), ...onWindow!.mock.calls].map((c) => c[0]);
    expect(types).toContain("resize");
    expect(types).toContain("pointermove");
    expect(types).not.toContain("scroll");
  });
});

describe("touch", () => {
  const stubPointer = (coarse: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

  it("(pointer: coarse): the hit area fills the gutter (24px) and, when not hovered or focused, carries a faint always-visible marker", () => {
    stubPointer(true);
    const { separators } = setup([twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.width).toBe(`${COLUMN_GAP_PX}px`);
    expect(sep.hasAttribute("data-touch")).toBe(true);
    expect(document.activeElement).not.toBe(sep);
  });

  it("mouse (not coarse): hit area 8px, no always-visible marker", () => {
    stubPointer(false);
    const { separators } = setup([twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.width).toBe("8px");
    expect(sep.hasAttribute("data-touch")).toBe(false);
  });
});

describe("unexpected events mid-drag", () => {
  it("unmount during a drag: the preview table is removed, body user-select is restored, later pointer events write nothing", () => {
    document.body.style.userSelect = "text";
    const { editor, separators, unmount } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    expect(document.body.style.userSelect).toBe("none");
    unmount();
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("text");
    move(600);
    up(600);
    expect(previewTables().length).toBe(0);
    expect(updates).not.toHaveBeenCalled();
  });

  it("the row becomes stacked during a drag: dividers and preview table disappear, user-select is restored, a later release writes nothing", () => {
    const { editor, separators, rowEl } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    Object.defineProperty(rowEl("r"), "clientWidth", { value: 300, configurable: true });
    fire(rowEl("r"));
    expect(rowEl("r").hasAttribute(STACKED_ATTR)).toBe(true);
    flushFrames();
    expect(separators("r").length).toBe(0);
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(widths("r")).toEqual([1, 1]);
  });

  it.each([
    ["document width proportional to the screen", [0.4, 1.6]],
    ["document narrower than the minimum width, screen held up by the minimum width", [0.3, 1.7]],
  ] as const)("left column already at the minimum width (%s): pressing the left and right arrow keys makes no Y update and leaves the undo stack unchanged", (_label, start) => {
    const { editor, separators } = setup([twoCols("r", [...start])]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    expect(sep.getAttribute("aria-valuenow")).toBe("20");
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    const updates = countUpdates(editor);
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(updates).not.toHaveBeenCalled();
    expect(manager.undoStack.length).toBe(stack);
    expect(widths("r")).toEqual([...start]);
  });
});
