import { defaultProps } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MAX } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { findNodeById, type PMNodeLike } from "./position";

type PMNode = EditorView["state"]["doc"];
type PMSelection = EditorView["state"]["selection"];

const BLOCK_CONTAINER = "blockContainer";
// Not imported from `layout-extension.ts` to avoid a cycle.
const STACKED_ATTR = "data-stacked";
const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

export type EdgeSide = "left" | "right";

export interface DraggedBlocks {
  readonly ids: readonly string[];
  readonly kind: "node" | "multi";
  readonly hasRows: boolean;
}

export type EdgeTarget =
  | { kind: "newRow"; yId: string; side: EdgeSide; pos: number }
  | { kind: "addColumn"; rowId: string; columnId: string; side: EdgeSide; pos: number };

export interface ColumnBox {
  id: string;
  pos: number;
  left: number;
  right: number;
}

export interface RowBox {
  id: string;
  pos: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  stacked: boolean;
  columns: ColumnBox[];
}

export type EdgeHit =
  | { kind: "top"; yPos: number; side: EdgeSide }
  | { kind: "column"; rowId: string; colIndex: number; side: EdgeSide };

export function edgeZone(boxWidth: number): number {
  return Math.min(64, Math.max(24, 0.2 * boxWidth));
}

// Outside the box is not an edge: the ⋮⋮ sits outside the block's left side and the pointer parks there during ordinary up/down reordering.
export function edgeSideOf(box: { left: number; right: number }, x: number): EdgeSide | null {
  const z = edgeZone(box.right - box.left);
  if (x >= box.left && x < box.left + z) return "left";
  if (x > box.right - z && x <= box.right) return "right";
  return null;
}

// Within a row the column is decided by x against the column rects: the blank area under a short column belongs to it, while `posAtCoords` there can snap into a neighbouring column.
export function columnAt(rows: readonly RowBox[], x: number, y: number): { row: RowBox; colIndex: number | null } | null {
  for (const row of rows) {
    if (row.stacked || y < row.top || y > row.bottom || x < row.left || x > row.right) continue;
    const index = row.columns.findIndex((col) => x >= col.left && x <= col.right);
    return { row, colIndex: index < 0 ? null : index };
  }
  return null;
}

export function rowsOf(view: EditorView): RowBox[] {
  const rows: RowBox[] = [];
  view.dom.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((el) => {
    const id = el.getAttribute("data-id");
    if (!id) return;
    const rect = el.getBoundingClientRect();
    const columns: ColumnBox[] = [];
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      const colId = child.getAttribute("data-id");
      if (child.getAttribute("data-node-type") !== COLUMN_TYPE || !colId) continue;
      const colRect = child.getBoundingClientRect();
      // Column and row DOM is itself the contentDOM: offset 0 is the start of the node's content, so subtract 1 for the position before it.
      columns.push({ id: colId, pos: view.posAtDOM(child, 0) - 1, left: colRect.left, right: colRect.right });
    }
    rows.push({
      id,
      pos: view.posAtDOM(el, 0) - 1,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      stacked: el.hasAttribute(STACKED_ATTR),
      columns,
    });
  });
  return rows;
}

// When the ends are in different columns, core's `nodes` holds only the first column's blocks, so compare the ends' parents too.
export function draggedFromSelection(sel: PMSelection): DraggedBlocks | null {
  const single = (sel as { node?: PMNode }).node;
  if (single) {
    const id = single.attrs.id;
    return single.type.name === BLOCK_CONTAINER && typeof id === "string" && id ? { ids: [id], kind: "node", hasRows: false } : null;
  }
  const nodes = (sel as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0 || !sel.$from.sameParent(sel.$to)) return null;
  const topLevel = sel.$from.depth === 1;
  const ids: string[] = [];
  let hasRows = false;
  for (const node of nodes as PMNode[]) {
    const id = node.attrs.id;
    if (typeof id !== "string" || !id) return null;
    if (node.type.name === COLUMN_LIST_TYPE && topLevel) hasRows = true;
    else if (node.type.name !== BLOCK_CONTAINER) return null;
    ids.push(id);
  }
  return { ids, kind: "multi", hasRows };
}

const DEFAULT_KEYS = ["textColor", "backgroundColor", "textAlignment"] as const;

// Any non-default attribute makes it non-empty (the user may have set formatting on purpose).
export function isEmptyParagraph(node: PMNode): boolean {
  if (node.type.name !== BLOCK_CONTAINER || node.childCount !== 1) return false;
  const content = node.firstChild!;
  if (content.type.name !== "paragraph" || content.content.size !== 0) return false;
  return DEFAULT_KEYS.every((key) => (content.attrs[key] ?? defaultProps[key].default) === defaultProps[key].default);
}

export function insideAny(pos: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([from, to]) => pos >= from && pos < to);
}

function wholeColumnOf(row: PMNode, ids: readonly string[]): number {
  for (let i = 0; i < row.childCount; i++) {
    const col = row.child(i);
    if (col.childCount !== ids.length) continue;
    let same = true;
    col.forEach((block, _offset, j) => {
      if (block.attrs.id !== ids[j]) same = false;
    });
    if (same) return i;
  }
  return -1;
}

// null = use the normal horizontal line. Dropping X, exactly all of column C's blocks, next to C would only add an empty column, so that is null too.
// When X is only part of the target column the line shows as usual: the result moves X into a new neighbouring column.
export function classifyEdge(doc: PMNode, dragged: DraggedBlocks, hit: EdgeHit): EdgeTarget | null {
  if (dragged.hasRows || dragged.ids.length === 0) return null;
  const ranges: Array<readonly [number, number]> = [];
  for (const id of dragged.ids) {
    const found = findNodeById(doc as unknown as PMNodeLike, id, BLOCK_CONTAINER);
    if (!found) return null;
    ranges.push([found.pos, found.pos + found.node.nodeSize]);
  }

  if (hit.kind === "top") {
    const y = doc.nodeAt(hit.yPos);
    const yId = y?.attrs.id;
    if (!y || y.type.name !== BLOCK_CONTAINER || doc.resolve(hit.yPos).depth !== 1 || typeof yId !== "string") return null;
    if (insideAny(hit.yPos, ranges)) return null;
    return { kind: "newRow", yId, side: hit.side, pos: hit.yPos };
  }

  const found = findNodeById(doc as unknown as PMNodeLike, hit.rowId, COLUMN_LIST_TYPE);
  if (!found) return null;
  const row = found.node as unknown as PMNode;
  if (insideAny(found.pos, ranges) || row.childCount >= COLUMNS_MAX) return null;
  if (hit.colIndex < 0 || hit.colIndex >= row.childCount) return null;
  const column = row.child(hit.colIndex);
  const columnId = column.attrs.id;
  if (typeof columnId !== "string") return null;

  const source = wholeColumnOf(row, dragged.ids);
  if (source >= 0) {
    const k = hit.colIndex;
    const noOp =
      (k === source && hit.side === "left") ||
      (k === source && hit.side === "right") ||
      (k === source - 1 && hit.side === "right") ||
      (k === source + 1 && hit.side === "left");
    if (noOp) return null;
  }

  let pos = found.pos + 1;
  for (let i = 0; i < hit.colIndex; i++) pos += row.child(i).nodeSize;
  return { kind: "addColumn", rowId: hit.rowId, columnId, side: hit.side, pos };
}

// isMac and dragMoves mirror prosemirror-view's internal browser.mac / dragMoves (not exported), so this agrees with PM's own moved flag.
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const safari = /Apple Computer/.test(navigator.vendor);
  const ios = safari && (/Mobile\/\w+/.test(navigator.userAgent) || navigator.maxTouchPoints > 2);
  return ios || /Mac/.test(navigator.platform);
}

export type PointerLike = { clientX: number; clientY: number; ctrlKey?: boolean; altKey?: boolean; synthetic?: boolean };

export function dragMoves(view: EditorView, event: PointerLike): boolean {
  let copy: boolean | undefined;
  view.someProp("dragCopies", (test) => {
    copy = copy || test(event as DragEvent);
  });
  return copy != null ? !copy : !event[isMac() ? "altKey" : "ctrlKey"];
}

type QualifiedY =
  | { kind: "top"; pos: number }
  | { kind: "column"; rowId: string; colIndex: number; colPos: number };

function qualifiedYAt(doc: PMNode, pos: number): QualifiedY | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 2; d--) {
    if ($pos.node(d).type.name !== BLOCK_CONTAINER) continue;
    if (d === 2) return { kind: "top", pos: $pos.before(d) };
    if ($pos.node(d - 1).type.name === COLUMN_TYPE) {
      const rowId = $pos.node(d - 2).attrs.id;
      if (typeof rowId !== "string") return null;
      return { kind: "column", rowId, colIndex: $pos.index(d - 2), colPos: $pos.before(d - 1) };
    }
  }
  return null;
}

/**
 * Shared by the DropCursor line and the drop, so what is drawn matches what is dropped. Reads only the `dragged` recorded at dragstart, never the
 * current selection (a remote update mid-drag makes y-prosemirror restore a multi-selection to a text selection).
 * Synthetic events are bailed out: core's SideMenu clamps a drop outside the box into it and fires again at exactly the left edge zone.
 */
export function edgeTargetAt(view: EditorView, event: PointerLike, dragged: DraggedBlocks | null): EdgeTarget | null {
  if (!view.editable || view.dragging == null || dragged == null || event.synthetic === true) return null;
  if (!dragMoves(view, event)) return null;
  const { clientX: x, clientY: y } = event;
  const doc = view.state.doc;

  const inRow = columnAt(rowsOf(view), x, y);
  if (inRow) {
    if (inRow.colIndex === null) return null;
    const side = edgeSideOf(inRow.row.columns[inRow.colIndex]!, x);
    return side && classifyEdge(doc, dragged, { kind: "column", rowId: inRow.row.id, colIndex: inRow.colIndex, side });
  }

  let pos: number | undefined;
  try {
    pos = view.posAtCoords({ left: x, top: y })?.pos;
  } catch {
    return null;
  }
  if (pos === undefined) return null;
  const target = qualifiedYAt(doc, pos);
  if (!target) return null;
  const el = view.nodeDOM(target.kind === "top" ? target.pos : target.colPos);
  if (!(el instanceof HTMLElement)) return null;
  const side = edgeSideOf(el.getBoundingClientRect(), x);
  if (!side) return null;
  return target.kind === "top"
    ? classifyEdge(doc, dragged, { kind: "top", yPos: target.pos, side })
    : classifyEdge(doc, dragged, { kind: "column", rowId: target.rowId, colIndex: target.colIndex, side });
}
