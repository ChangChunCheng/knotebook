/**
 * Takes over ⋮⋮ drops through `handleDrop`: by then every `handleDOMEvents.drop` (PasteRule, UniqueID) has run, and returning true makes PM `preventDefault()` and clear `view.dragging`.
 * `buildInsert` first runs on the predicted document (X removed) to validate; then two `editor.transact` calls in one undo step: remove X (no column cleanup), then insert.
 * y-prosemirror diffs once per view update; with removal and insertion in one transaction the diff wraps and rewrites the unrelated blocks between the two spots, losing text a peer types there.
 * `stopCapturing` isn't called between them, so the UndoManager merges the two.
 * Neither transaction carries `uiEvent` (PasteRule would run over the diff range when `uiEvent === "drop"` and turn URLs in the middle blocks into links); both carry `preventAutolink`
 * (autolink runs on every doc-changing transaction, and a move has no newly typed text).
 */
import { removeAndInsertBlocks, type BlockNoteEditor, type ComputeDropPositionContext } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { TEXT_REPRESENTATION_MIME_TYPES } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { dragMoves, edgeTargetAt, insideAny, isEmptyParagraph, type DraggedBlocks, type EdgeTarget } from "./drag-geometry";
import { draggedBlocksOf } from "./drag-source";
import { buildInsert, selectionBase, textSelectionNear, type InsertPlan } from "./edge-drop-insert";
import { findNodeById, type PMNodeLike } from "./position";
import { asUndoStep } from "./undo-step";
import { addColumnWidths, equalHeightWidths } from "./widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;
type PMNode = EditorView["state"]["doc"];
type Transaction = EditorView["state"]["tr"];
type Slice = NonNullable<EditorView["dragging"]>["slice"];
type ResolvedPos = ReturnType<PMNode["resolve"]>;

const BLOCK_CONTAINER = "blockContainer";

const find = (doc: PMNode, id: string, type?: string): { node: PMNode; pos: number } | null =>
  findNodeById(doc as unknown as PMNodeLike, id, type) as { node: PMNode; pos: number } | null;

// Read from the current doc so remote changes to X's attrs/text are kept.
function nodesOf(doc: PMNode, ids: readonly string[]): { node: PMNode; pos: number }[] | null {
  const out: { node: PMNode; pos: number }[] = [];
  for (const id of ids) {
    const hit = find(doc, id);
    if (!hit) return null;
    out.push(hit);
  }
  return out;
}

function imageAspect(view: EditorView, block: PMNode): number | null {
  const content = block.firstChild;
  if (block.type.name !== BLOCK_CONTAINER || block.childCount !== 1 || content?.type.name !== "image" || content.attrs.showPreview === false) return null;
  const id = block.attrs.id;
  const hit = typeof id === "string" ? find(view.state.doc, id, BLOCK_CONTAINER) : null;
  const dom = hit ? view.nodeDOM(hit.pos) : null;
  const img = dom instanceof HTMLElement ? dom.querySelector("img") : null;
  if (!img || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return null;
  return img.naturalWidth / img.naturalHeight;
}

const columnAspect = (view: EditorView, blocks: readonly PMNode[]): number | null => (blocks.length === 1 ? imageAspect(view, blocks[0]!) : null);

// An added column's existing columns are read from `predicted`: when X was already in this row, its source column no longer contains X.
function planFor(view: EditorView, predicted: PMNode, target: EdgeTarget, xNodes: PMNode[]): InsertPlan | null {
  const xAspect = columnAspect(view, xNodes);
  if (target.kind === "newRow") {
    const y = find(predicted, target.yId, BLOCK_CONTAINER);
    if (!y) return null;
    const yAspect = columnAspect(view, [y.node]);
    const order = target.side === "left" ? [xAspect, yAspect] : [yAspect, xAspect];
    const widths = (equalHeightWidths(order) ?? [1, 1]) as [number, number];
    return { kind: "newRow", yId: target.yId, side: target.side, xNodes, widths };
  }
  const row = find(predicted, target.rowId, COLUMN_LIST_TYPE);
  if (!row) return null;
  const existing: number[] = [];
  const aspects: (number | null)[] = [];
  let k = -1;
  row.node.forEach((col, _offset, i) => {
    existing.push(col.attrs.width as number);
    const blocks: PMNode[] = [];
    col.forEach((b) => void blocks.push(b));
    aspects.push(columnAspect(view, blocks));
    if (col.attrs.id === target.columnId) k = i;
  });
  if (k < 0) return null;
  const newIndex = target.side === "left" ? k : k + 1;
  aspects.splice(newIndex, 0, xAspect);
  const widths = equalHeightWidths(aspects) ?? addColumnWidths(existing, newIndex);
  return { kind: "addColumn", rowId: target.rowId, columnId: target.columnId, side: target.side, xNodes, widths };
}

/**
 * After an undo, y-prosemirror restores the "pre-operation selection" by relative position on the next redo; if another block then sits where X was,
 * that whole block gets selected. Replace X's NodeSelection with a text selection first (selection only, nothing written to Yjs).
 */
function collapseNodeSelection(view: EditorView): void {
  const sel = view.state.selection;
  if (!("node" in sel)) return;
  const text = textSelectionNear(sel, sel.$from);
  if (text) view.dispatch(view.state.tr.setSelection(text));
}

function removeX(tr: Transaction, ids: readonly string[]): void {
  removeAndInsertBlocks(tr, [...ids], [], { fixColumns: false });
  tr.setMeta("preventAutolink", true);
}

// The two transactions run synchronously, so no remote update can slip in and `buildInsert` on the real document can't fail; if it does that's a programming error and it throws.
function commitMove(editor: AnyEditor, view: EditorView, ids: readonly string[], makePlan: (predicted: PMNode) => InsertPlan | null): boolean {
  const tr1 = view.state.tr;
  removeX(tr1, ids);
  const predicted = view.state.apply(tr1);
  const plan = makePlan(predicted.doc);
  if (!plan || !buildInsert(predicted.tr, plan)) return false;
  // Must come after validation: core's `view.dragging` has no `node`, so on `return false` PM's default drop removes the source with `deleteSelection()`;
  // changing the selection first would delete something other than X and leave a second copy.
  collapseNodeSelection(view);
  asUndoStep(editor, () => {
    editor.transact((tr) => removeX(tr, ids));
    editor.transact((tr) => {
      if (!buildInsert(tr, plan)) throw new Error("edge-drop: insert target vanished after pre-validation");
      tr.setMeta("preventAutolink", true);
    });
  });
  // PM's default drop focuses the editor; once we take over, nobody else does.
  view.focus();
  return true;
}

export function edgeDrop(editor: AnyEditor | null, view: EditorView, event: DragEvent): boolean {
  if (!editor) return false;
  const dragged = draggedBlocksOf(view);
  const target = edgeTargetAt(view, event, dragged);
  if (!target || !dragged) return false;
  const x = nodesOf(view.state.doc, dragged.ids);
  if (!x) return false;
  const xNodes = x.map((hit) => hit.node);
  return commitMove(editor, view, dragged.ids, (predicted) => planFor(view, predicted, target, xNodes));
}

// apps/web can't import prosemirror-transform at value level, so this reimplements its `dropPoint` (the one PM's default drop uses).
function pmDropPoint(doc: PMNode, pos: number, slice: Slice): number | null {
  const $pos: ResolvedPos = doc.resolve(pos);
  if (!slice.content.size) return pos;
  let content = slice.content;
  for (let i = 0; i < slice.openStart; i++) content = content.firstChild!.content;
  for (let pass = 1; pass <= (slice.openStart === 0 && slice.size ? 2 : 1); pass++) {
    for (let d = $pos.depth; d >= 0; d--) {
      const bias = d === $pos.depth ? 0 : $pos.pos <= ($pos.start(d + 1) + $pos.end(d + 1)) / 2 ? -1 : 1;
      const insertPos = $pos.index(d) + (bias > 0 ? 1 : 0);
      const parent = $pos.node(d);
      let fits: boolean;
      if (pass === 1) {
        fits = parent.canReplace(insertPos, insertPos, content);
      } else {
        const wrapping = parent.contentMatchAt(insertPos).findWrapping(content.firstChild!.type);
        fits = !!wrapping && parent.canReplaceWith(insertPos, insertPos, wrapping[0]!);
      }
      if (fits) return bias === 0 ? $pos.pos : bias < 0 ? $pos.before(d + 1) : $pos.after(d + 1);
    }
  }
  return null;
}

function flattenX(nodes: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    if (node.type.name === COLUMN_LIST_TYPE) node.forEach((col) => col.forEach((b) => void out.push(b)));
    else out.push(node);
  }
  return out;
}

function isBlockMove(editor: AnyEditor, view: EditorView, event: DragEvent, dragged: DraggedBlocks | null): dragged is DraggedBlocks {
  return dragged != null && editor.isEditable && view.dragging != null && dragMoves(view, event) && (event as { synthetic?: boolean }).synthetic !== true;
}

/**
 * When a column's only block is an empty, unformatted paragraph E, replaces E with X (PM's default would leave `[E, X]` or `[X, E]`). E must not be inside any X's subtree (dragging E itself, or a row
 * dropped into its own empty column: removing X would delete the column too), and PM's own `dropPoint` must also land inside the column.
 * `edgeTargetAt` returns null here for "not an edge", so `isBlockMove` has to filter read-only / synthetic / copy drags first.
 */
export function emptyColumnDrop(editor: AnyEditor | null, view: EditorView, event: DragEvent, slice: Slice): boolean {
  if (!editor) return false;
  const dragged = draggedBlocksOf(view);
  if (!isBlockMove(editor, view, event, dragged)) return false;
  if (edgeTargetAt(view, event, dragged) !== null) return false;

  const doc = view.state.doc;
  let mouse: number | undefined;
  try {
    mouse = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    return false;
  }
  if (mouse === undefined) return false;
  const $mouse = doc.resolve(mouse);
  let depth = -1;
  for (let d = $mouse.depth; d > 0; d--) {
    if ($mouse.node(d).type.name === COLUMN_TYPE) {
      depth = d;
      break;
    }
  }
  if (depth < 0) return false;
  const column = $mouse.node(depth);
  const columnPos = $mouse.before(depth);
  const columnId = column.attrs.id;
  const empty = column.firstChild;
  if (typeof columnId !== "string" || column.childCount !== 1 || !empty || !isEmptyParagraph(empty)) return false;
  const emptyId = empty.attrs.id;
  if (typeof emptyId !== "string") return false;

  const x = nodesOf(doc, dragged.ids);
  if (!x) return false;
  // E is C's only child block, so "E is inside some X's subtree" is exactly "C is inside X's subtree, or X is E".
  if (insideAny(columnPos + 1, x.map((hit) => [hit.pos, hit.pos + hit.node.nodeSize] as const))) return false;

  // Safety net: for a blockContainer slice `dropPoint` always lands in the nearest column, so current drags never reach this.
  const at = pmDropPoint(doc, $mouse.pos, slice) ?? $mouse.pos;
  if (!(at > columnPos && at < columnPos + column.nodeSize)) return false;

  const xNodes = flattenX(x.map((hit) => hit.node));
  return commitMove(editor, view, dragged.ids, () => ({ kind: "replaceEmpty", columnId, emptyId, xNodes }));
}

function runsOf(x: readonly { node: PMNode; pos: number }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const hit of [...x].sort((p, q) => p.pos - q.pos)) {
    const end = hit.pos + hit.node.nodeSize;
    const last = out.at(-1);
    if (last && hit.pos < last[1]) last[1] = Math.max(last[1], end);
    else if (last && hit.pos === last[1]) last[1] = end;
    else out.push([hit.pos, end]);
  }
  return out;
}

// Several blocks select from the start of the first to the end of the last: the ends sit in different blocks, so dragging ⋮⋮ again still makes core treat it as a multi-selection.
function selectInserted(tr: Transaction, slice: Slice, at: number): void {
  const idOf = (node: PMNode | null | undefined) => (typeof node?.attrs.id === "string" ? node.attrs.id : null);
  const firstId = idOf(slice.content.firstChild);
  const lastId = idOf(slice.content.lastChild);
  const first = firstId ? find(tr.doc, firstId) : null;
  const base = selectionBase(tr.selection);
  const anchor = base.findFrom(tr.doc.resolve(first ? first.pos + 1 : Math.min(at, tr.doc.content.size)), 1, true) ?? base.findFrom(tr.doc.resolve(at), -1, true);
  if (!anchor) return;
  const last = slice.content.childCount > 1 && lastId ? find(tr.doc, lastId) : null;
  const head = last ? base.findFrom(tr.doc.resolve(last.pos + last.node.nodeSize - 1), -1, true) : null;
  if (head && head.head > anchor.anchor) {
    const TextSel = anchor.constructor as unknown as { create(doc: PMNode, anchor: number, head: number): EditorView["state"]["selection"] };
    tr.setSelection(TextSel.create(tr.doc, anchor.anchor, head.head));
  } else {
    tr.setSelection(anchor);
  }
}

/**
 * Follows PM's default drop (`handleDrop` in prosemirror-view) with two differences: it removes the X recorded at dragstart, not the current selection
 * (a remote update mid-drag makes y-prosemirror restore a text selection, and `deleteSelection()` would leave an empty block, #429), and it ends in a
 * text selection instead of the NodeSelection PM gives a single block.
 */
function moveBlocks(editor: AnyEditor, view: EditorView, event: DragEvent, slice: Slice, ids: readonly string[]): boolean {
  const doc = view.state.doc;
  const x = nodesOf(doc, ids);
  if (!x || !slice.content.size) return false;
  let mouse: number | undefined;
  try {
    mouse = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    return false;
  }
  if (mouse === undefined) return false;
  const insertAt = pmDropPoint(doc, mouse, slice) ?? mouse;
  const runs = runsOf(x);
  const build = (tr: Transaction): Transaction | null => {
    const mapFrom = tr.steps.length;
    for (const [from, to] of runs) {
      const mapping = tr.mapping.slice(mapFrom);
      tr.deleteRange(mapping.map(from), mapping.map(to));
    }
    const pos = tr.mapping.map(insertAt);
    const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1;
    const beforeInsert = tr.doc;
    if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild!);
    else tr.replaceRange(pos, pos, slice);
    if (tr.doc.eq(beforeInsert)) return null;
    selectInserted(tr, slice, pos);
    return tr.setMeta("uiEvent", "drop");
  };
  if (!build(view.state.tr)) return false;
  // Same as `commitMove`: only the selection changes, so the rebuilt transaction equals the one trial-built above.
  collapseNodeSelection(view);
  const tr = build(view.state.tr);
  // The selection is already swapped; handing back to PM's default would `deleteSelection()` something other than X. If the rebuild fails, abandon the drop.
  if (!tr) return true;
  asUndoStep(editor, () => {
    // Same order as PM's default drop: focus, then dispatch.
    view.focus();
    view.dispatch(tr);
  });
  return true;
}

// Also takes the synthetic event core's SideMenu clamps into the box: when the drop lands outside the box PM only receives that one. Ordered after `edgeDrop` and `emptyColumnDrop`.
export function blockMoveDrop(editor: AnyEditor | null, view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  if (!editor || !moved || !editor.isEditable) return false;
  const dragged = draggedBlocksOf(view);
  if (!dragged || view.dragging == null || (view.dragging as { node?: unknown }).node) return false;
  return moveBlocks(editor, view, event, slice, dragged.ids);
}

type DropPos = ComputeDropPositionContext["defaultPosition"];

// Never returns null: null makes core draw no line at all.
export function computeDropPosition(ctx: ComputeDropPositionContext): DropPos {
  const view = ctx.view as unknown as EditorView;
  const target = edgeTargetAt(view, ctx.event, draggedBlocksOf(view));
  if (!target) return ctx.defaultPosition;
  return { pos: target.pos, orientation: target.side === "left" ? "block-vertical-left" : "block-vertical-right" };
}

// Mirrors core fileDropExtension's check.
function firstKnownTypeIsFiles(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes("Files") && !TEXT_REPRESENTATION_MIME_TYPES.some((type) => types.includes(type));
}

const distance = (value: number, from: number, to: number): number => (value < from ? from - value : value > to ? value - to : 0);

// Columns are compared by horizontal distance first, then vertical: side-by-side rows differ in x per column, stacked rows share one x range.
// The box is `nodeDOM` (`.bn-block-outer`), the element core's `handleFileInsertion` finds by `[data-id]` to decide before/after.
function gutterTargetRect(view: EditorView, event: DragEvent): DOMRect | null {
  let pos: number | undefined;
  try {
    pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    return null;
  }
  if (pos === undefined) return null;
  const $pos = view.state.doc.resolve(pos);
  const rowNode = $pos.parent;
  if (rowNode.type.name !== COLUMN_LIST_TYPE) return null;
  const { clientX: x, clientY: y } = event;
  const column = nearestChild(view, rowNode, $pos.start(), (rect) => [distance(x, rect.left, rect.right), distance(y, rect.top, rect.bottom)]);
  if (!column) return null;
  return nearestChild(view, column.node, column.pos + 1, (rect) => [distance(y, rect.top, rect.bottom)])?.rect ?? null;
}

function closer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

function nearestChild(
  view: EditorView,
  parent: PMNode,
  start: number,
  dist: (rect: DOMRect) => readonly number[],
): { node: PMNode; pos: number; rect: DOMRect } | null {
  let best: { node: PMNode; pos: number; rect: DOMRect; d: readonly number[] } | null = null;
  let pos = start;
  for (let i = 0; i < parent.childCount; i++) {
    const node = parent.child(i);
    const el = view.nodeDOM(pos);
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      const d = dist(rect);
      if (!best || closer(d, best.d)) best = { node, pos, rect, d };
    }
    pos += node.nodeSize;
  }
  return best;
}

// y stays on its side (upper half → upper quarter) so core's midline before/after decision matches a pointer beside B. A native DragEvent's coordinates are
// prototype getters, so same-named own properties override them.
function moveInto(event: DragEvent, rect: DOMRect): void {
  const mid = (rect.top + rect.bottom) / 2;
  const y = event.clientY < mid ? (rect.top + mid) / 2 : (mid + rect.bottom) / 2;
  Object.defineProperty(event, "clientX", { value: (rect.left + rect.right) / 2, configurable: true });
  Object.defineProperty(event, "clientY", { value: y, configurable: true });
}

/**
 * Wraps `handleDOMEvents.drop` to handle drops between columns. A gutter position's parent is `columnList`, which can't hold any block:
 * - ⋮⋮ drag (`view.dragging` set) that isn't an edge drop → move the coordinates into the nearest block of the nearest column, then hand to the inner handler. This must happen before the inner one:
 *   the inner `withColumnsDropPoint` records the drop point on entry, and PM's default drop later reads the same coordinates. Edge drops (`edgeTargetAt` has a target) keep their coordinates,
 *   so the line drawn during the drag matches the drop result.
 * - File-only drops → the inner handler runs first (media blocking takes priority; blocked ones aren't handled); only if it returns false are the coordinates moved, and we return false so core's
 *   `fileDropExtension` inserts and uploads as usual, before or after that block.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers type `view` differently (`unknown` / EditorView); this only passes it through
export function withGutterFileDrop<T extends { drop: (view: any, e: DragEvent) => boolean }>(editorRef: EditorRef, events: T): T {
  return {
    ...events,
    drop: (view: EditorView | null, event: DragEvent) => {
      const editor = editorRef.current;
      const usable = !!view && !!editor && editor.isEditable && view.editable;
      if (usable && view.dragging != null && edgeTargetAt(view, event, draggedBlocksOf(view)) === null) {
        const rect = gutterTargetRect(view, event);
        if (rect) moveInto(event, rect);
      }
      if (events.drop(view, event)) return true;
      if (usable && view.dragging == null && firstKnownTypeIsFiles(event)) {
        const rect = gutterTargetRect(view, event);
        if (rect) moveInto(event, rect);
      }
      return false;
    },
  };
}
