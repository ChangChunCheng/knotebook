/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's internal view/selection objects (types unavailable in apps/web) */
import { afterEach, describe, expect, it, vi } from "vitest";
import { P, mountEditor, row, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import {
  classifyEdge,
  columnAt,
  draggedFromSelection,
  edgeSideOf,
  edgeTargetAt,
  edgeZone,
  insideAny,
  isEmptyParagraph,
  rowsOf,
  type DraggedBlocks,
  type RowBox,
} from "./drag-geometry";
import { STACKED_ATTR } from "./layout-extension";
import { findNodeById } from "./position";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.restoreAllMocks();
});

function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return { ...mounted, view: mounted.editor.prosemirrorView as any };
}

const posOf = (view: any, id: string): number => (findNodeById(view.state.doc, id) as { pos: number }).pos;
const textPosIn = (view: any, id: string): number => posOf(view, id) + 2;

type Box = readonly [left: number, top: number, right: number, bottom: number];

/**
 * jsdom rects are all 0: values are looked up by `<data-node-type>:<data-id>` (`blockOuter:y1`, `columnList:r`, `column:rc0`). Mounted on the prototype and returning by identity: PM replaces elements when column widths or the document change, so a mock on a single element would go stale. Elements not in the table fall through to the original implementation.
 */
function mockRects(boxes: Record<string, Box>): void {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes[`${this.getAttribute("data-node-type")}:${this.getAttribute("data-id")}`];
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : original.call(this);
  });
}

/** Row `id` (column ids `${id}c${i}`) spans x 0-600, y top-bottom; n equal-width columns with 24px gutters. */
function rowBoxes(id: string, top: number, bottom: number, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, top, 600, bottom] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), top, i * (width + 24) + width, bottom];
  return out;
}

/**
 * The real core drag-handle path: the handle stand-in is mounted under `view.dom`'s parent (`editor.mount(el)` makes el itself `view.dom`); its dragstart calls `blockDragStart` and bubbles to root so SideMenu sets `view.dragging`. With two block ids in `range`, the text selection is first dragged from the first to the second (core turns it into a multi-selection). Returns the X determined by the selection at the moment of dragstart.
 */
function startBlockDrag(editor: AnyEditor, blockId: string, range?: readonly [string, string]): DraggedBlocks | null {
  const view = editor.prosemirrorView as any;
  if (range) {
    const TextSelection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPosIn(view, range[0]), textPosIn(view, range[1]))));
  }
  const data = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    clearData: () => data.clear(),
    setDragImage: () => {},
    items: [],
    files: [],
    effectAllowed: "uninitialized",
    dropEffect: "none",
  };
  const handle = document.createElement("div");
  editor.domElement!.parentElement!.appendChild(handle);
  handle.addEventListener("dragstart", (e) => (editor.getExtension("sideMenu") as any).blockDragStart(e, editor.getBlock(blockId)));
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  handle.dispatchEvent(event);
  handle.remove();
  expect(view.dragging).toBeTruthy();
  return draggedFromSelection(view.state.selection);
}

const stubPosAtCoords = (view: any, pos: number) => vi.spyOn(view, "posAtCoords").mockReturnValue({ pos, inside: -1 });

describe("left/right edge zones and in-row column lookup (pure geometry)", () => {
  it("edgeZone: 0.2 x box width clamped to [24, 64]", () => {
    expect([100, 200, 320, 1000].map(edgeZone)).toEqual([24, 40, 64, 64]);
  });

  it("edgeSideOf: left zone [left, left+z), right zone (right-z, right], outside the box doesn't count", () => {
    const box = { left: 0, right: 100 };
    const cases: Array<[number, "left" | "right" | null]> = [
      [0, "left"],
      [23, "left"],
      [24, null],
      [-1, null],
      [76, null],
      [77, "right"],
      [100, "right"],
      [101, null],
    ];
    for (const [x, side] of cases) expect([x, edgeSideOf(box, x)]).toEqual([x, side]);
  });

  // [long column | short column]: row height 400, short column content only to 50; column boxes always use the row height, so blank space below the short column still belongs to it.
  const rows: RowBox[] = [
    {
      id: "r",
      pos: 0,
      top: 0,
      bottom: 400,
      left: 0,
      right: 600,
      stacked: false,
      columns: [
        { id: "long", pos: 1, left: 0, right: 288 },
        { id: "short", pos: 20, left: 312, right: 600 },
      ],
    },
  ];

  it("columnAt: blank space below the short column is located by x in the short column; gutter -> colIndex null; outside the row -> null", () => {
    expect(columnAt(rows, 600 - 5, 300)).toEqual({ row: rows[0], colIndex: 1 });
    expect(columnAt(rows, 300, 300)).toEqual({ row: rows[0], colIndex: null });
    expect(columnAt(rows, 300, 401)).toBeNull();
    expect(columnAt(rows, 601, 300)).toBeNull();
  });

  it("columnAt: stacked rows don't count", () => {
    expect(columnAt([{ ...rows[0]!, stacked: true }], 600 - 5, 300)).toBeNull();
  });
});

describe("unstacked rows locate the column by x, not via posAtCoords", () => {
  function setup() {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 2)); // rc0 0-288, rc1 312-600
    const dragged = startBlockDrag(m.editor, "z1");
    const spy = stubPosAtCoords(m.view, textPosIn(m.view, "a1")); // deliberately returns a position in column 1
    return { ...m, dragged, spy };
  }

  it("posAtCoords returns column 1 but x is in column 2's right edge zone -> add column on column 2's right, posAtCoords never called", () => {
    const { view, dragged, spy } = setup();
    expect(edgeTargetAt(view, { clientX: 590, clientY: 280 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc1",
      side: "right",
      pos: posOf(view, "rc1"),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("x in the gutter -> null, posAtCoords never called", () => {
    const { view, dragged, spy } = setup();
    expect(edgeTargetAt(view, { clientX: 300, clientY: 200 }, dragged)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("same coordinates with a stacked row -> goes via posAtCoords (called once)", () => {
    const { view, dragged, spy } = setup();
    // The stacking plugin can't measure widths in jsdom; set the attribute it writes directly and read synchronously (PM's MutationObserver only processes in a microtask).
    view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");
    edgeTargetAt(view, { clientX: 590, clientY: 280 }, dragged);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rowsOf: row and column pos are the position before the node (posAtDOM(el, 0) - 1), and the stack attribute is readable", () => {
    const { view } = setup();
    const [box] = rowsOf(view);
    expect(box).toMatchObject({ id: "r", pos: posOf(view, "r"), top: 100, bottom: 300, left: 0, right: 600, stacked: false });
    expect(box!.columns).toEqual([
      { id: "rc0", pos: posOf(view, "rc0"), left: 0, right: 288 },
      { id: "rc1", pos: posOf(view, "rc1"), left: 312, right: 600 },
    ]);
    view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");
    expect(rowsOf(view)[0]!.stacked).toBe(true);
  });
});

describe("eligible target blocks (not inside an unstacked row, via posAtCoords)", () => {
  const stack = (view: any) => view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");

  it("top-level block -> its .bn-block-outer is the box, creates a row", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 10, clientY: 115 }, dragged)).toEqual({ kind: "newRow", yId: "y1", side: "left", pos: posOf(view, "y1") });
  });

  it("direct child block of a column (stacked row) -> the containing column is the box, adds a column", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc1": [0, 200, 600, 260] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, textPosIn(view, "b1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 230 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc1",
      side: "right",
      pos: posOf(view, "rc1"),
    });
  });

  it("indented child block in a column -> falls to the column's direct child block, judged by column", () => {
    const { editor, view } = mount([row([[withChildren(P("a", "a1"), [P("a2", "a2")])], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc0": [0, 100, 600, 190] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, textPosIn(view, "a2"));
    expect(edgeTargetAt(view, { clientX: 5, clientY: 150 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "left",
      pos: posOf(view, "rc0"),
    });
  });

  it("child block of a top-level block -> falls to the top-level block", () => {
    const { editor, view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    mockRects({ "blockOuter:p1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, textPosIn(view, "q1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 150 }, dragged)).toEqual({ kind: "newRow", yId: "p1", side: "right", pos: posOf(view, "p1") });
  });

  const table = (id: string): PartialBlockLike =>
    ({ id, type: "table", content: { type: "tableContent", rows: [{ cells: ["k", "l"] }] } }) as PartialBlockLike;
  const cellPos = (view: any, tableId: string): number => {
    let pos = -1;
    view.state.doc.nodeAt(posOf(view, tableId)).descendants((n: any, p: number) => {
      if (pos < 0 && n.isText) pos = posOf(view, tableId) + 1 + p;
    });
    return pos;
  };

  it("cell of a top-level table -> falls to the table block", () => {
    const { editor, view } = mount([table("t1"), P("z", "z1")]);
    mockRects({ "blockOuter:t1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, cellPos(view, "t1"));
    expect(view.state.doc.resolve(cellPos(view, "t1")).parent.type.name).toBe("tableParagraph"); // precondition: the drop point is really inside the cell
    expect(edgeTargetAt(view, { clientX: 590, clientY: 130 }, dragged)).toEqual({ kind: "newRow", yId: "t1", side: "right", pos: posOf(view, "t1") });
  });

  it("cell of a table inside a column -> falls to the column containing the table", () => {
    const { editor, view } = mount([row([[table("t1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc0": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, cellPos(view, "t1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 130 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "right",
      pos: posOf(view, "rc0"),
    });
  });

  it("posAtCoords returns null or throws -> null", () => {
    const { editor, view } = mount([P("x", "x1"), P("z", "z1")]);
    const dragged = startBlockDrag(editor, "z1");
    vi.spyOn(view, "posAtCoords").mockReturnValue(null);
    expect(edgeTargetAt(view, { clientX: 5, clientY: 5 }, dragged)).toBeNull();
    vi.spyOn(view, "posAtCoords").mockImplementation(() => {
      throw new Error("posAtCoords");
    });
    expect(edgeTargetAt(view, { clientX: 5, clientY: 5 }, dragged)).toBeNull();
  });
});

describe("no vertical line is shown", () => {
  function base() {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(m.editor, "z1");
    stubPosAtCoords(m.view, textPosIn(m.view, "y1"));
    return { ...m, dragged, event: { clientX: 590, clientY: 115 } };
  }

  it("baseline: dragging z to y's right edge -> creates a row (control for the cases below)", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, event, dragged)).toEqual({ kind: "newRow", yId: "y1", side: "right", pos: posOf(view, "y1") });
  });

  it("synthetic event (the one with coordinates clamped into the box) -> null", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, { ...event, synthetic: true }, dragged)).toBeNull();
  });

  it("copy drag (Ctrl on non-mac) -> null; on mac Ctrl doesn't count, Alt does", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, { ...event, ctrlKey: true }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { ...event, altKey: true }, dragged)).not.toBeNull();
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    cleanups.push(() => delete (navigator as any).platform);
    expect(navigator.platform).toBe("MacIntel");
    expect(edgeTargetAt(view, { ...event, altKey: true }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { ...event, ctrlKey: true }, dragged)).not.toBeNull();
  });

  it("editor read-only -> null", () => {
    const { editor, view, dragged, event } = base();
    editor.isEditable = false;
    expect(view.editable).toBe(false);
    expect(edgeTargetAt(view, event, dragged)).toBeNull();
  });

  it("no recorded X (dragged == null) -> null", () => {
    const { view, event } = base();
    expect(edgeTargetAt(view, event, null)).toBeNull();
  });

  it("not dragging (view.dragging == null) -> null", () => {
    const { view, dragged, event } = base();
    view.dragging = null;
    expect(edgeTargetAt(view, event, dragged)).toBeNull();
  });

  it("X contains a column -> draggedFromSelection returns null; an X built by hand with a column id also returns null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    const dragged = startBlockDrag(editor, "y1", ["y1", "z1"]);
    expect(dragged).toEqual({ ids: ["y1", "z1"], kind: "multi", hasRows: false });
    const MultipleNodeSelection = view.state.selection.constructor;
    const rc0 = posOf(view, "rc0");
    const overColumn = MultipleNodeSelection.create(view.state.doc, rc0, rc0 + view.state.doc.nodeAt(rc0).nodeSize);
    expect(overColumn.nodes.map((n: any) => n.type.name)).toEqual(["column"]); // precondition: really a multi-selection containing only columns
    expect(draggedFromSelection(overColumn)).toBeNull();
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, { ids: ["rc0"], kind: "multi", hasRows: false })).toBeNull();
  });

  it("X contains a row (multi-selection of top-level p and a row) -> hasRows, null", () => {
    const { editor, view } = mount([P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    const dragged = startBlockDrag(editor, "p1", ["p1", "a1"]);
    expect(dragged).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, { ...dragged!, ids: ["p1"], hasRows: false })).not.toBeNull(); // control: dragging only p
  });

  it("multi-selection across columns (the two ends have different parents) -> draggedFromSelection returns null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("d", "d1")]], "r"), P("y", "y1")]);
    const dragged = startBlockDrag(editor, "a1", ["a1", "d1"]);
    const sel = view.state.selection;
    expect(sel.toJSON().type).toBe("multiple-node"); // precondition: core turns a text selection across columns into a multi-selection
    expect(sel.$from.sameParent(sel.$to)).toBe(false);
    expect(dragged).toBeNull();
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, dragged)).toBeNull();
  });

  it("top-level Y is X itself -> null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "y1");
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 115 }, dragged)).toBeNull();
  });

  it("top-level Y is the second of a multi-selection X -> null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "x1", ["x1", "y1"]);
    expect(dragged).toEqual({ ids: ["x1", "y1"], kind: "multi", hasRows: false });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 115 }, dragged)).toBeNull();
  });

  it("pointer on a child block of X (the eligible Y falls to X itself) -> null", () => {
    const { editor, view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    mockRects({ "blockOuter:p1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "p1");
    stubPosAtCoords(view, textPosIn(view, "q1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 150 }, dragged)).toBeNull();
  });

  it("row already has 4 columns -> null (control: a 3-column row can take one more)", () => {
    const four = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 4)); // rc1 156-288
    const dragged4 = startBlockDrag(four.editor, "z1");
    expect(edgeTargetAt(four.view, { clientX: 280, clientY: 200 }, dragged4)).toBeNull();
    four.destroy();
    cleanups = cleanups.filter((c) => c !== four.destroy);
    vi.restoreAllMocks();

    const three = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 3)); // rc1 208-392
    const dragged3 = startBlockDrag(three.editor, "z1");
    expect(edgeTargetAt(three.view, { clientX: 385, clientY: 200 }, dragged3)).toMatchObject({ kind: "addColumn", columnId: "rc1", side: "right" });
  });

  // Three-column row [a|b|c] (rc0 0-184, rc1 208-392, rc2 416-600), X = b (all of column 2): inserting at column 2's left/right edge, the left neighbour's right edge or the right neighbour's left edge only adds an empty column. Control: with an extra b2 in column 2 and X still b, the same coordinates do show a vertical line.
  const noOps: Array<[string, number, string, "left" | "right"]> = [
    ["column 2's left edge", 210, "rc1", "left"],
    ["column 2's right edge", 390, "rc1", "right"],
    ["left neighbour's right edge", 182, "rc0", "right"],
    ["right neighbour's left edge", 418, "rc2", "left"],
  ];
  it.each(noOps)("no-op: X is all of a column, inserting at %s -> null (control: shown when the column has other blocks)", (_label, x, columnId, side) => {
    const whole = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 3));
    const dragged = startBlockDrag(whole.editor, "b1");
    expect(edgeTargetAt(whole.view, { clientX: x, clientY: 200 }, dragged)).toBeNull();
    whole.destroy();
    cleanups = cleanups.filter((c) => c !== whole.destroy);
    vi.restoreAllMocks();

    const partial = mount([row([[P("a", "a1")], [P("b", "b1"), P("b2", "b2")], [P("c", "c1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 3));
    const dragged2 = startBlockDrag(partial.editor, "b1");
    expect(edgeTargetAt(partial.view, { clientX: x, clientY: 200 }, dragged2)).toMatchObject({ kind: "addColumn", columnId, side });
  });

  it("no-op: [a|b] dragging b to a's right edge -> null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "b1");
    expect(edgeTargetAt(view, { clientX: 280, clientY: 200 }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 5, clientY: 200 }, dragged)).toMatchObject({ kind: "addColumn", columnId: "rc0", side: "left" }); // control
  });

  it("column targets are judged per column: [a,b,c|d] with a, b multi-selected, pointer in column 1's right edge zone over a and over c -> the same target", () => {
    const { editor, view } = mount([row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "a1", ["a1", "b1"]);
    expect(dragged).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
    const onA = edgeTargetAt(view, { clientX: 280, clientY: 110 }, dragged);
    const onC = edgeTargetAt(view, { clientX: 280, clientY: 170 }, dragged);
    expect(onA).toEqual({ kind: "addColumn", rowId: "r", columnId: "rc0", side: "right", pos: posOf(view, "rc0") });
    expect(onC).toEqual(onA);
  });

  it("the decision uses the recorded X, not the current selection: a vertical line is still shown after a multi-selection degrades to a text selection", () => {
    const { editor, view } = mount([row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "a1", ["a1", "b1"]);
    expect(dragged).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    const text = Selection.fromJSON(view.state.doc, { type: "text", anchor: textPosIn(view, "a1"), head: textPosIn(view, "b1") });
    view.dispatch(view.state.tr.setSelection(text));
    expect(view.state.selection.toJSON().type).toBe("text"); // precondition: the current selection is no longer a multi-selection
    expect(draggedFromSelection(view.state.selection)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 280, clientY: 170 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "right",
      pos: posOf(view, "rc0"),
    });
  });
});

describe("draggedFromSelection", () => {
  it("drag handle drags a single block -> node", () => {
    const { editor } = mount([P("x", "x1"), P("y", "y1")]);
    expect(startBlockDrag(editor, "y1")).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
  });

  it("NodeSelection that isn't a blockContainer, or a text selection -> null", () => {
    const { view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    const rowSel = Selection.fromJSON(view.state.doc, { type: "node", anchor: posOf(view, "r") });
    expect(rowSel.node.type.name).toBe("columnList");
    expect(draggedFromSelection(rowSel)).toBeNull();
    const contentSel = Selection.fromJSON(view.state.doc, { type: "node", anchor: posOf(view, "y1") + 1 });
    expect(contentSel.node.type.name).toBe("paragraph");
    expect(draggedFromSelection(contentSel)).toBeNull();
    expect(draggedFromSelection(Selection.fromJSON(view.state.doc, { type: "text", anchor: textPosIn(view, "y1"), head: textPosIn(view, "y1") }))).toBeNull();
  });

  it("multi-selection of two blocks in a column -> multi, in document order", () => {
    const { editor } = mount([row([[P("a", "a1"), P("b", "b1")], [P("d", "d1")]], "r")]);
    expect(startBlockDrag(editor, "a1", ["a1", "b1"])).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
  });
});

describe("empty paragraph and subtree check", () => {
  const container = (props: Record<string, unknown> | undefined, extra?: Partial<PartialBlockLike>): PartialBlockLike =>
    ({ id: "e1", type: "paragraph", content: [], ...(props ? { props } : {}), ...extra }) as PartialBlockLike;
  const isEmpty = (block: PartialBlockLike): boolean => {
    const { view } = mount([P("x", "x1"), block]);
    return isEmptyParagraph(view.state.doc.nodeAt(posOf(view, "e1")));
  };

  it("empty paragraph -> true", () => expect(isEmpty(container(undefined))).toBe(true));
  it("has text -> false", () => expect(isEmpty(P("e", "e1"))).toBe(false));
  it("has child blocks -> false", () => expect(isEmpty(container(undefined, { children: [P("k", "k1")] }))).toBe(false));
  it("non-default text color -> false", () => expect(isEmpty(container({ textColor: "red" }))).toBe(false));
  it("non-default background color -> false", () => expect(isEmpty(container({ backgroundColor: "blue" }))).toBe(false));
  it("non-default alignment -> false", () => expect(isEmpty(container({ textAlignment: "center" }))).toBe(false));
  it("type is heading -> false", () => expect(isEmpty({ id: "e1", type: "heading", props: { level: 1 }, content: [] } as PartialBlockLike)).toBe(false));

  it("insideAny: [start, end)", () => {
    expect(insideAny(5, [[0, 10]])).toBe(true);
    expect(insideAny(0, [[0, 10]])).toBe(true);
    expect(insideAny(10, [[0, 10]])).toBe(false);
    expect(insideAny(15, [[0, 10], [12, 20]])).toBe(true);
    expect(insideAny(5, [])).toBe(false);
  });
});

describe("classifyEdge top-level target", () => {
  it("yPos isn't before a top-level blockContainer -> null", () => {
    const { view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    const dragged: DraggedBlocks = { ids: ["z1"], kind: "node", hasRows: false };
    expect(classifyEdge(view.state.doc, dragged, { kind: "top", yPos: posOf(view, "p1"), side: "left" })).toMatchObject({ kind: "newRow", yId: "p1" });
    expect(classifyEdge(view.state.doc, dragged, { kind: "top", yPos: posOf(view, "q1"), side: "left" })).toBeNull();
  });

  it("X's id isn't found in the current document -> null", () => {
    const { view } = mount([P("y", "y1"), P("z", "z1")]);
    const hit = { kind: "top", yPos: posOf(view, "y1"), side: "right" } as const;
    expect(classifyEdge(view.state.doc, { ids: ["z1"], kind: "node", hasRows: false }, hit)).not.toBeNull();
    expect(classifyEdge(view.state.doc, { ids: ["z1", "gone"], kind: "multi", hasRows: false }, hit)).toBeNull();
  });

  it("X flagged hasRows -> null (control: the same ids without hasRows create a row)", () => {
    const { view } = mount([P("p", "p1"), P("y", "y1")]);
    const hit = { kind: "top", yPos: posOf(view, "y1"), side: "right" } as const;
    expect(classifyEdge(view.state.doc, { ids: ["p1"], kind: "multi", hasRows: false }, hit)).toMatchObject({ kind: "newRow", yId: "y1" });
    expect(classifyEdge(view.state.doc, { ids: ["p1"], kind: "multi", hasRows: true }, hit)).toBeNull();
  });
});
