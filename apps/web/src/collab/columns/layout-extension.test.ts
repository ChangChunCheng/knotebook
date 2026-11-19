import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { columnListBlockSpec, createHeadlessNoteSchema } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { IMG, P, mountEditor, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { COLUMN_KIND_ATTR, STACKED_ATTR, columnsLayoutExtension, withColumnsLayout } from "./layout-extension";

/**
 * ResizeObserver stand-in that can be fired manually: records observe targets; tests always trigger through `fire(el)`, which first asserts el was observed - calling the callback directly on an unobserved element would let the wiring defect "the plugin never observes" pass vacuously.
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
    observed.delete(target);
    this.targets.delete(target);
  }
  disconnect() {
    for (const t of this.targets) observed.delete(t);
    this.targets.clear();
  }
}

function fire(el: Element) {
  expect(observed.has(el)).toBe(true);
  for (const ro of instances) {
    if (ro.targets.has(el)) ro.callback([{ target: el } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver);
  }
}

function setWidth(el: Element, value: number) {
  Object.defineProperty(el, "clientWidth", { value, configurable: true });
}

const rowEl = (root: ParentNode) => root.querySelector<HTMLElement>('[data-node-type="columnList"]')!;
const columnEls = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-node-type="column"]'));

let cleanups: Array<() => void> = [];
beforeEach(() => {
  observed.clear();
  instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.unstubAllGlobals();
});

function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return mounted;
}

const textRow = () => [P("x", "x0"), row([[P("a")], [P("b")]], "r"), P("z", "z9")];

describe("stacking", () => {
  it("two text columns: row width 300 -> data-stacked; changed to 900 -> removed", () => {
    const { container } = mount(textRow());
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true);
    setWidth(rowEl(container), 900);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });

  it("clientWidth 0 (not laid out, hidden) -> not stacked", () => {
    const { container } = mount(textRow());
    setWidth(rowEl(container), 0);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });

  it("two all-image columns, row width 300 -> not stacked (96+24+96 <= 300)", () => {
    const { container } = mount([P("x", "x0"), row([[IMG("i1")], [IMG("i2")]], "r"), P("z", "z9")]);
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("wiring on the editor.mount path (DiffEditor / public page), no transactions after mount", () => {
  it("without mountEditor/BlockNoteView: view() observes at creation, and dispatches no transaction before fire", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: textRow() as never }) as AnyEditor;
    const div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    cleanups.push(() => {
      editor.unmount();
      div.remove();
    });
    setWidth(rowEl(div), 300);
    fire(rowEl(div));
    expect(rowEl(div).hasAttribute(STACKED_ATTR)).toBe(true);
    setWidth(rowEl(div), 900);
    fire(rowEl(div));
    expect(rowEl(div).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("rows appearing/disappearing after mount", () => {
  it("no row at mount, one inserted later (/grid, paste, undo bringing it back) -> update() scans and observes it, row width 300 -> stacked", () => {
    const { editor, container } = mount([P("x", "x0"), P("z", "z9")]);
    expect(rowEl(container)).toBeNull();
    editor.insertBlocks([row([[P("a")], [P("b")]], "r2")], "x0", "after");
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true);
  });

  it("row deleted, then a notification from the old element -> no longer observed", () => {
    const { editor, container } = mount(textRow());
    const old = rowEl(container);
    editor.removeBlocks(["r"]);
    expect(old.isConnected).toBe(false);
    setWidth(old, 0);
    fire(old);
    expect(observed.has(old)).toBe(false);
  });

  it("an element removed from the DOM and unobserved, then reattached -> the next update()'s scan() observes it again", () => {
    const { editor, container } = mount(textRow());
    const el = rowEl(container);
    const parent = el.parentNode!;
    const next = el.nextSibling;
    el.remove();
    fire(el);
    expect(observed.has(el)).toBe(false);
    parent.insertBefore(el, next);
    editor.setTextCursorPosition("x0", "end");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    expect(rowEl(container)).toBe(el);
    expect(observed.has(el)).toBe(true);
  });
});

describe("image-only columns", () => {
  it("image column gets data-kb-col-kind=image, text column doesn't", () => {
    const { container } = mount([P("x", "x0"), row([[IMG("i1")], [P("b", "b1")]], "r"), P("z", "z9")]);
    const [imageCol, textCol] = columnEls(container);
    expect(imageCol.getAttribute(COLUMN_KIND_ATTR)).toBe("image");
    expect(textCol.hasAttribute(COLUMN_KIND_ATTR)).toBe(false);
  });
});

describe("no ResizeObserver", () => {
  it("mount doesn't throw", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    expect(() => mount(textRow())).not.toThrow();
  });
});

describe("recompute on content change (row width unchanged, no more fire)", () => {
  it("images -> text swapped column by column: recomputed with the latest measured width 400", async () => {
    const { editor, container } = mount([P("x", "x0"), row([[IMG("i1")], [IMG("i2")]], "r"), P("z", "z9")]);
    setWidth(rowEl(container), 400);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);

    editor.replaceBlocks(["i1"], [P("t1", "t1")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:t1) | COL(image)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false); // [text, image] needs 200+24+96 = 320 <= 400

    editor.replaceBlocks(["i2"], [P("t2", "t2")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:t1) | COL(paragraph:t2)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true); // 424 > 400

    editor.replaceBlocks(["t1"], [IMG("j1")]);
    editor.replaceBlocks(["t2"], [IMG("j2")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(image) | COL(image)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("shared spec unchanged", () => {
  it("shared columnListBlockSpec and the headless schema don't include the layout extension; noteSchema does; withColumnsLayout returns a new object", () => {
    expect(columnListBlockSpec.extensions ?? []).not.toContain(columnsLayoutExtension);
    expect(createHeadlessNoteSchema(window.location.href).blockSpecs.columnList.extensions ?? []).not.toContain(columnsLayoutExtension);
    expect(noteSchema.blockSpecs.columnList.extensions).toContain(columnsLayoutExtension);
    expect(withColumnsLayout(columnListBlockSpec)).not.toBe(columnListBlockSpec);
  });
});
