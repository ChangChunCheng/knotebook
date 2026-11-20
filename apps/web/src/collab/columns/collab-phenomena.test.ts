import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { P, blockPos, integrity, pressKey, row, shape, startBlockDrag, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import * as edgeDropModule from "./edge-drop";
import { createColumnEdgeKeymapExtension } from "./edge-keymap";
import { removeBlocksKeepColumns } from "./keep-columns";
import { findNodeById } from "./position";
import { writeColumnWidths } from "./width-preview";
import { dividerResize, ratiosFromPixels } from "./widths";

// Media blocking calls toast, which only the full-options editor (`buildNoteEditorOptions`) has; replaced by a spy to avoid touching real UI.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

// Two clients (recording phenomena). What's tested is the merge behaviour of y-prosemirror and core, not the columns feature's own code: cases for "known limitations" hard-code the observed values; the rest (marked "safe") going red is a regression.

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  toastMock.mockReset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Two collab editors, each with its own Y.Doc, synced through `Y.applyUpdate`. By default both mount only the column edge keymaps (`createColumnEdgeKeymapExtension`); the one listed in `full` uses the full `buildNoteEditorOptions` options (`handleDrop` chain, drag-source recorder, DropCursor hook), so drag-drop goes through the product's takeover path.
 */
async function collabPair(initial: PartialBlockLike[], opts: { full?: readonly ("a" | "b")[] } = {}) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number): AnyEditor => {
    const editorRef: EditorRef = { current: null };
    const full = opts.full?.includes(n === 1 ? "a" : "b");
    const editor = BlockNoteEditor.create(
      full
        ? buildNoteEditorOptions({
            doc,
            provider: { awareness: null } as never,
            user: { id: `u${n}`, name: `User ${n}` },
            language: "en",
            translate: (k) => k,
            editorRef,
            noteId: "n",
            siteLinks: { current: null },
          })
        : withCollaboration({
            schema: noteSchema,
            collaboration: {
              provider: { awareness: undefined },
              fragment: doc.getXmlFragment(YDOC_FRAGMENT),
              user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
            },
            _tiptapOptions: { extensions: [createColumnEdgeKeymapExtension({ editorRef })] },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
          } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
    ) as any as AnyEditor;
    editorRef.current = editor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return editor;
  };
  const a = make(d1, 1);
  await tick();
  a.replaceBlocks(a.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = async () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
    await tick();
  };
  return { a, b, sync };
}

const allText = (editor: AnyEditor) => {
  let s = "";
  editor.prosemirrorView!.state.doc.descendants((n) => {
    if (n.isText) s += n.text + "|";
  });
  return s;
};

const typeText = (editor: AnyEditor, text: string) => {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(text));
};
const typeAtEnd = (editor: AnyEditor, id: string, text: string) => {
  editor.setTextCursorPosition(id, "end");
  typeText(editor, text);
};

/** Types at the end of the `index`-th table cell's text (document order; in a 2x2 table 0 = top-left, 3 = bottom-right). */
const typeInCell = (editor: AnyEditor, index: number, text: string) => {
  const view = editor.prosemirrorView!;
  const cells: number[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells.push(pos);
  });
  const pos = cells[index]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Selection class is taken from the constructor of the current selection
  const Sel = view.state.selection.constructor as any;
  const end = Sel.near(view.state.doc.resolve(pos + view.state.doc.nodeAt(pos)!.nodeSize - 1), -1);
  view.dispatch(view.state.tr.setSelection(end).insertText(text));
};

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
const AB = () => [P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z9")];

describe("two clients (recording phenomena)", () => {
  it("safe: A types in column 1, B presses Enter at the end of column 2 and types -> both sides keep both people's text, the row is still a valid two-column row", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "end");
    expect(pressKey(b, "Enter")).toBe(true);
    typeText(b, "BBB");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toContain("AAA");
      expect(allText(e)).toContain("BBB");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b,paragraph:BBB)]  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("known limitation: A types in column 1 while B presses Backspace at the start of b (flatten) -> A's text disappears", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "start");
    expect(pressKey(b, "Backspace")).toBe(true);
    expect(shape(b)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).not.toContain("AAA");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("known limitation: two blocks in the same column are deleted by two people separately -> y-prosemirror deletes the whole row", async () => {
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"), P("z", "z9")]);
    removeBlocksKeepColumns(a, ["a1"]);
    removeBlocksKeepColumns(b, ["q1"]);
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:q) | COL(paragraph:b)]  paragraph:z");
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("safe: 2x2 table in a column, A types in the top-left cell and B in the bottom-right -> both cells keep their own text, row and table valid", async () => {
    const table: PartialBlockLike = {
      id: "t1",
      type: "table",
      content: { type: "tableContent", rows: [{ cells: ["c00", "c01"] }, { cells: ["c10", "c11"] }] },
    };
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[table], [P("b", "b1")]], "r"), P("z", "z9")]);
    typeInCell(a, 0, "_A");
    typeInCell(b, 3, "_B");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toBe("x|c00_A|c01|c10|c11_B|b|z|");
      expect(shape(e)).toBe("paragraph:x  ROW[COL(table) | COL(paragraph:b)]  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("safe: A types in column 1 while B adds a column 3 and a paragraph below the row -> the text survives, the row has 3 columns, the paragraph below exists", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.transact((tr) => {
      const list = findNodeById(tr.doc, "r", "columnList")!;
      const column = tr.doc.type.schema.nodes.column!.createAndFill()!;
      tr.insert(list.pos + list.node.nodeSize - 1, column);
    });
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph)]  paragraph:z");
    b.insertBlocks([P("below", "n1")], "r", "after");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b) | COL(paragraph)]  paragraph:below  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });
});

type Box = readonly [left: number, top: number, right: number, bottom: number];

/** Taken before any spy is attached: a case swaps the drop-target editor and re-mounts mocks, so the fallback must not pick up a spy itself. */
const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;

/**
 * jsdom rects are all 0. Only elements inside the drop-target editor (`target`) are looked up by `<data-node-type>:<data-id>`: both editors have the same ids, so an unscoped lookup would give the other editor the same table. The editors' root `.bn-block-group`: the drop-target's returns a box enclosing all test coordinates, the other's sits beyond x 5000 (well outside core SideMenu's 250px range). Core's capture drop on root uses this box to find the nearest editor: when the nearest isn't the drop target it treats the drop as a drag to another editor; for coordinates within 250px outside the box it first dispatches a synthetic event with the coordinates clamped into the box. Mounted on the prototype and returning by identity: PM replaces elements whenever the document changes, so a mock on a single element would go stale.
 */
function mockRects(target: AnyEditor, boxes: Record<string, Box>): void {
  const dom = target.prosemirrorView!.dom;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    let box: Box | undefined;
    if (this.classList.contains("bn-block-group") && this.parentElement?.classList.contains("bn-editor")) {
      box = this.parentElement === dom ? [0, 0, 1000, 1000] : [5000, 0, 6000, 1000];
    } else if (dom.contains(this)) {
      box = boxes[`${this.getAttribute("data-node-type")}:${this.getAttribute("data-id")}`];
    }
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : ORIGINAL_RECT.call(this);
  });
}

/** Row `id` (column ids `${id}c${i}`) spans x 0-600, y 100-300; n equal-width columns with 24px gutters. */
function rowBoxes(id: string, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, 100, 600, 300] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), 100, i * (width + 24) + width, 300];
  return out;
}

const topBox = (id: string, top: number): Record<string, Box> => ({ [`blockOuter:${id}`]: [0, top, 600, top + 30] });

interface Gesture {
  drag: string;
  target: string;
  at: readonly [number, number];
  boxes: Record<string, Box>;
}

/**
 * One drag-handle drag-drop on `editor`: real dragstart (core `blockDragStart`, bubbling to document so the drag-source recorder records X) -> dispatch drop on `view.dom` -> add dragend on the drag source like a browser. `posAtCoords` always returns the start of `target`'s text (jsdom has no layout).
 */
function dragDrop(editor: AnyEditor, g: Gesture): DragEvent {
  mockRects(editor, g.boxes);
  const { dataTransfer } = startBlockDrag(editor, g.drag);
  const view = editor.prosemirrorView!;
  const pos = blockPos(editor, g.target) + 2;
  view.posAtCoords = () => ({ pos, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: g.at[0] });
  Object.defineProperty(event, "clientY", { value: g.at[1] });
  Object.defineProperty(event, "ctrlKey", { value: false });
  Object.defineProperty(event, "altKey", { value: false });
  view.dom.dispatchEvent(event);
  editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
  return event as DragEvent;
}

type Handler = "edgeDrop" | "emptyColumnDrop";

/**
 * `dropper` takes over one drag-drop through the product's `handleDrop` while `typist` types `text` at the end of `typeIn` (neither side has received the other's update), then they sync. Asserts: `dropper`'s `handleDrop` is the full-options one, `handler` is called once with a non-synthetic event, and it took over; `typist`'s selection is unaffected by the drop.
 */
async function dropWhileTyping(
  pair: { sync: () => Promise<void> },
  dropper: AnyEditor,
  gesture: Gesture,
  typist: AnyEditor,
  typeIn: string,
  text: string,
  handler: Handler = "edgeDrop",
): Promise<void> {
  expect(dropper.prosemirrorView!.someProp("handleDrop", (f) => f)).toBeTypeOf("function");
  const spy: MockInstance = vi.spyOn(edgeDropModule, handler);
  typist.setTextCursorPosition(typeIn, "end");
  const typistSelection = typist.prosemirrorView!.state.selection.toJSON();
  const event = dragDrop(dropper, gesture);
  expect(spy).toHaveBeenCalledTimes(1);
  expect((spy.mock.calls[0]![2] as { synthetic?: boolean }).synthetic).not.toBe(true);
  expect(spy.mock.results[0]!.value).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(typist.prosemirrorView!.state.selection.toJSON()).toEqual(typistSelection);
  spy.mockRestore();
  typeText(typist, text);
  await pair.sync();
}

function expectSameAndClean(a: AnyEditor, b: AnyEditor): void {
  expect(shape(b)).toBe(shape(a));
  expect(allText(b)).toBe(allText(a));
  for (const e of [a, b]) expect(integrity(e)).toEqual(CLEAN);
}

function blockHolding(editor: AnyEditor, text: string): string {
  let id = "gone";
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === "blockContainer" && node.firstChild?.textContent.includes(text)) id = String(node.attrs.id);
  });
  return id;
}

type RowBlock = { id: string; children: Array<{ props: { width: number }; children: Array<{ content?: Array<{ text?: string }> }> }> };
const rowBlock = (editor: AnyEditor, rowId: string): RowBlock => editor.document.find((block) => block.id === rowId) as unknown as RowBlock;
const widthsOf = (editor: AnyEditor, rowId: string): number[] => rowBlock(editor, rowId).children.map((col) => col.props.width);

describe("two clients: other side types during a drag-drop (B mounted with full options, real dragstart + drop)", () => {
  // Recorded: Y is replaced by a new row, so A's text typed in Y disappears with the old Y (holder "gone", merged `ROW[y|x] z`).
  it("recorded: B drags x onto y's right edge creating a row [y|x] while A types in y -> row valid, both sides equal, records which block A's text landed in", async () => {
    const pair = await collabPair([P("y", "y1"), P("x", "x1"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "y1", "AAA");
    expectSameAndClean(a, b);
    console.log("new row, not last block", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  // Recorded: A's text isn't in y; it appears in the empty paragraph added after the row (merged `ROW[y|x]  paragraph:AAA`).
  it("recorded: new row is the document's last block (empty paragraph added after it), A types in y -> row valid, both sides equal, records which block A's text landed in", async () => {
    const pair = await collabPair([P("x", "x1"), P("y", "y1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "y1", "AAA");
    expectSameAndClean(a, b);
    console.log("new row, last block", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  it("safe: top-level [y, m, x], B drags x onto y's right edge creating a row, A types in m -> m keeps A's text", async () => {
    const pair = await collabPair([P("y", "y1"), P("m", "m1"), P("x", "x1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "m1", "MM");
    expectSameAndClean(a, b);
    for (const e of [a, b]) {
      expect(blockHolding(e, "MM")).toBe("m1");
      expect(shape(e)).toBe("ROW[COL(paragraph:y) | COL(paragraph:x)]  paragraph:mMM");
    }
  });

  it("safe: z outside [a|b] dragged by B to b's right edge adding a column, A types in a -> text kept, three columns", async () => {
    const pair = await collabPair([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "z1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 2) }, a, "a1", "AAA");
    expectSameAndClean(a, b);
    for (const e of [a, b]) expect(shape(e)).toBe("ROW[COL(paragraph:aAAA) | COL(paragraph:b) | COL(paragraph:z)]");
  });

  it.each([
    ["existing column widths unchanged", [1, 1], [1, 1, 1]],
    // Two existing columns 0.4:1.2, the new column = average 0.8; the row is normalized to a sum of 3 -> [1, 0.5, 1.5]: the existing two keep their ratio but all values change.
    ["existing column widths change (unequal, sum differs from column count, row normalized after adding a column)", [0.4, 1.2], [1, 0.5, 1.5]],
  ] as const)("safe: [X,a|b], B drags X into a new leftmost column (%s), A types in a -> text kept", async (_label, widths, expected) => {
    const pair = await collabPair([row([[P("X", "X1"), P("a", "a1")], [P("b", "b1")]], "r", [...widths])], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "X1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 2) }, a, "a1", "AAA");
    expectSameAndClean(a, b);
    for (const e of [a, b]) {
      expect(shape(e)).toBe("ROW[COL(paragraph:X) | COL(paragraph:aAAA) | COL(paragraph:b)]");
      expect(widthsOf(e, "r")).toEqual(expected);
    }
  });

  // Recorded: the new columns each side inserted both stay, 5 columns after merge, all widths 1, `doc.check()` still passes; exceeds the 4-column cap of a single-user drag (a single-user drag into a 4-column row only gives a horizontal line).
  it("recorded: two people add a column by vertical line at different columns of a 3-column row at once -> row valid, both sides equal, records the column count", async () => {
    const pair = await collabPair([P("p", "p1"), P("q", "q1"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")], { full: ["a", "b"] });
    const { a, b } = pair;
    const spy = vi.spyOn(edgeDropModule, "edgeDrop");
    dragDrop(b, { drag: "p1", target: "c1", at: [590, 200], boxes: rowBoxes("r", 3) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]!.value).toBe(true);
    dragDrop(a, { drag: "q1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 3) });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.results[1]!.value).toBe(true);
    expect(shape(b)).toBe("paragraph:q  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:p)]");
    expect(shape(a)).toBe("paragraph:p  ROW[COL(paragraph:q) | COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
    await pair.sync();
    expectSameAndClean(a, b);
    const count = (a.document.find((block) => block.id === "r") as { children: unknown[] }).children.length;
    console.log("two columns added at once", JSON.stringify({ shape: shape(a), columns: count, widths: widthsOf(a, "r") }));
  });

  // Recorded: A's text typed in the empty paragraph E appears inside the z that replaces it. Whether it comes before or after z depends on the two Y.Docs' clientID order (`AAAz` or `zAAA`) and may differ every run, so it's only recorded, order isn't asserted.
  it("recorded: B drops z by horizontal line into empty column E while A types in E -> row valid, both sides equal, records which block A's text landed in", async () => {
    const pair = await collabPair([row([[P("a", "a1")], [P("", "e1")]], "r"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "z1", target: "e1", at: [456, 200], boxes: rowBoxes("r", 2) }, a, "e1", "AAA", "emptyColumnDrop");
    expectSameAndClean(a, b);
    console.log("drop into empty column", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  // Recorded: A's text isn't in the moved X; it appears in the empty paragraph left in the source column (merged original row `[a|AAA]`, the new row's X has no A text).
  it("recorded: B drags the source column's only X away by vertical line while A types in X -> row valid, both sides equal, records whether A's text is in the empty paragraph left in the source column", async () => {
    const pair = await collabPair([P("w", "w1"), row([[P("a", "a1")], [P("X", "X1")]], "r")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "X1", target: "w1", at: [590, 15], boxes: topBox("w1", 0) }, a, "X1", "AAA");
    expectSameAndClean(a, b);
    const sourceColumnText = rowBlock(a, "r").children[1]!.children.map((block) => (block.content ?? []).map((c) => c.text).join("")).join("|");
    console.log("source column drag-out", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA"), sourceColumnText }));
  });
});

/**
 * Releases the `index`-th divider following the divider component's algorithm on release (`dividerResize` clamps to the minimum width -> `ratiosFromPixels` makes only the two dragged columns absorb the rounding difference -> `writeColumnWidths` writes only changed columns, as its own undo step; columns other than the two dragged that someone else changed after press aren't written). `px` is each column's pixel width measured on press, `base` is the column widths in the document on press (omitted = as of now), the minimum width is 200px for text columns throughout. Returns the computed whole-row ratios.
 */
function releaseDivider(
  editor: AnyEditor,
  rowId: string,
  px: readonly number[],
  index: number,
  delta: number,
  base: readonly number[] = widthsOf(editor, rowId),
): number[] {
  const [left, right] = dividerResize(px[index]!, px[index + 1]!, 200, 200, delta);
  const next = [...px];
  next[index] = left;
  next[index + 1] = right;
  const ratios = ratiosFromPixels(next, [index, index + 1]);
  expect(writeColumnWidths(editor, rowId, ratios, { since: { base, own: [index, index + 1] } })).toBe(true);
  return ratios;
}

describe("two clients: other side edits while a divider is released", () => {
  it("safe: B releases a divider writing column widths while A types in both columns -> both people's text present, widths are the ones B wrote", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    typeAtEnd(a, "b1", "BBB");
    const written = releaseDivider(b, "r", [500, 500], 0, 200);
    expect(written).toEqual([1.4, 0.6]);
    expect(widthsOf(b, "r")).toEqual(written);
    expect(widthsOf(a, "r")).toEqual([1, 1]);
    await sync();
    expectSameAndClean(a, b);
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:bBBB)]  paragraph:z");
      expect(widthsOf(e, "r")).toEqual(written);
    }
  });

  // Recorded: both write the middle column; after merge the middle column takes one person's value (Y attribute conflicts are decided by clientID), and the other two columns keep the value of whoever wrote them, so the sum may differ from the column count. Each column is still in the valid range and reading out and writing back markdown isn't rejected.
  it("recorded: A and B adjust different divider pairs of the same row at once -> both sides equal, every column in [0.1, 10], records merged widths and sum", async () => {
    const pair = await collabPair([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z9")]);
    const { a, b } = pair;
    const fromA = releaseDivider(a, "r", [300, 300, 300], 0, 60);
    const fromB = releaseDivider(b, "r", [300, 300, 300], 1, 80);
    expect(fromA).toEqual([1.2, 0.8, 1]);
    expect(fromB).toEqual([1, 1.27, 0.73]);
    await pair.sync();
    expectSameAndClean(a, b);
    const merged = widthsOf(a, "r");
    expect(widthsOf(b, "r")).toEqual(merged);
    expect(merged).toHaveLength(3);
    for (const w of merged) {
      expect(w).toBeGreaterThanOrEqual(0.1);
      expect(w).toBeLessThanOrEqual(10);
    }
    const sum = Math.round(merged.reduce((s, w) => s + w, 0) * 100) / 100;
    console.log("divider pairs adjusted at once", JSON.stringify({ fromA, fromB, merged, sum }));
  });

  it("safe: B presses divider 2, A adjusts divider 1 and syncs over; B releases -> column 1 keeps A's value, only columns 2 and 3 follow B's write", async () => {
    const pair = await collabPair([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z9")]);
    const { a, b } = pair;
    const pressedPx = [300, 300, 300];
    const pressedBase = widthsOf(b, "r");
    expect(pressedBase).toEqual([1, 1, 1]);
    const fromA = releaseDivider(a, "r", [300, 300, 300], 0, 60);
    expect(fromA).toEqual([1.2, 0.8, 1]);
    await pair.sync();
    expect(widthsOf(b, "r")).toEqual([1.2, 0.8, 1]);
    const update = vi.spyOn(b, "updateBlock");
    const fromB = releaseDivider(b, "r", pressedPx, 1, 80, pressedBase);
    expect(fromB).toEqual([1, 1.27, 0.73]);
    expect(update.mock.calls.map((c) => c[0])).toEqual(["rc1", "rc2"]);
    await pair.sync();
    expectSameAndClean(a, b);
    for (const e of [a, b]) expect(widthsOf(e, "r")).toEqual([1.2, 1.27, 0.73]);
  });
});
