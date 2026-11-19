// Runs on the predicted doc (X removed), then the real one; targets are re-found by id so both give the same step positions.
// A separate module so `edge-drop.ts` calls it through a module import and tests can `vi.spyOn` it (calls within one module use local bindings).
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MAX } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { isEmptyParagraph, type EdgeSide } from "./drag-geometry";
import { findNodeById, type PMNodeLike } from "./position";
import { changedIndices } from "./widths";

type PMNode = EditorView["state"]["doc"];
type Transaction = EditorView["state"]["tr"];
type PMSelection = EditorView["state"]["selection"];

const BLOCK_CONTAINER = "blockContainer";

export type InsertPlan =
  | { kind: "newRow"; yId: string; side: EdgeSide; xNodes: PMNode[]; widths: [number, number] }
  | { kind: "addColumn"; rowId: string; columnId: string; side: EdgeSide; xNodes: PMNode[]; widths: number[] }
  | { kind: "replaceEmpty"; columnId: string; emptyId: string; xNodes: PMNode[] };

const find = (doc: PMNode, id: string, type: string): { node: PMNode; pos: number } | null =>
  findNodeById(doc as unknown as PMNodeLike, id, type) as { node: PMNode; pos: number } | null;

interface SelectionStatics {
  findFrom(pos: unknown, dir: number, textOnly?: boolean): PMSelection | null;
}

// apps/web can't get prosemirror-state values, so walk up the prototype chain of the current selection.
export function selectionBase(sel: PMSelection): SelectionStatics {
  let ctor = sel.constructor as unknown as object;
  for (let parent = Object.getPrototypeOf(ctor); parent && parent !== Function.prototype; parent = Object.getPrototypeOf(ctor)) ctor = parent;
  return ctor as SelectionStatics;
}

export function textSelectionNear(sel: PMSelection, $pos: unknown): PMSelection | null {
  const base = selectionBase(sel);
  return base.findFrom($pos, 1, true) ?? base.findFrom($pos, -1, true);
}

// Always a text selection, never a NodeSelection (an X without text, such as an image, lands in the next text block).
function selectStart(tr: Transaction, pos: number): void {
  const sel = textSelectionNear(tr.selection, tr.doc.resolve(pos + 1));
  if (sel) tr.setSelection(sel);
}

const allBlocks = (nodes: readonly PMNode[]): boolean => nodes.length > 0 && nodes.every((n) => n.type.name === BLOCK_CONTAINER);

function newRow(tr: Transaction, plan: Extract<InsertPlan, { kind: "newRow" }>): boolean {
  const y = find(tr.doc, plan.yId, BLOCK_CONTAINER);
  if (!y || tr.doc.resolve(y.pos).depth !== 1 || !allBlocks(plan.xNodes)) return false;
  const { nodes } = tr.doc.type.schema;
  const xFirst = plan.side === "left";
  const [w0, w1] = plan.widths;
  const xCol = nodes[COLUMN_TYPE]!.createChecked({ width: xFirst ? w0 : w1 }, plan.xNodes);
  const yCol = nodes[COLUMN_TYPE]!.createChecked({ width: xFirst ? w1 : w0 }, y.node);
  const row = nodes[COLUMN_LIST_TYPE]!.createChecked(null, xFirst ? [xCol, yCol] : [yCol, xCol]);
  tr.replaceWith(y.pos, y.pos + y.node.nodeSize, row);
  // A row at the end of the document can't be left with the keyboard (same as `/grid`).
  const after = y.pos + row.nodeSize;
  const $after = tr.doc.resolve(after);
  if ($after.index() === $after.parent.childCount) {
    tr.insert(after, nodes[BLOCK_CONTAINER]!.createChecked(null, nodes["paragraph"]!.create()));
  }
  const xColPos = xFirst ? y.pos + 1 : y.pos + 1 + yCol.nodeSize;
  selectStart(tr, xColPos + 1);
  return true;
}

function addColumn(tr: Transaction, plan: Extract<InsertPlan, { kind: "addColumn" }>): boolean {
  const found = find(tr.doc, plan.rowId, COLUMN_LIST_TYPE);
  if (!found || !allBlocks(plan.xNodes)) return false;
  const row = found.node;
  if (row.childCount >= COLUMNS_MAX || plan.widths.length !== row.childCount + 1) return false;
  let colPos = found.pos + 1;
  let k = -1;
  for (let i = 0; i < row.childCount; i++) {
    if (row.child(i).attrs.id === plan.columnId) {
      k = i;
      break;
    }
    colPos += row.child(i).nodeSize;
  }
  if (k < 0) return false;
  const newIndex = plan.side === "left" ? k : k + 1;
  const insertPos = plan.side === "left" ? colPos : colPos + row.child(k).nodeSize;
  const before: number[] = [];
  row.forEach((col) => void before.push(col.attrs.width as number));
  const existingAfter = plan.widths.filter((_, i) => i !== newIndex);
  const { nodes } = tr.doc.type.schema;
  const newCol = nodes[COLUMN_TYPE]!.createChecked({ width: plan.widths[newIndex] }, plan.xNodes);
  tr.insert(insertPos, newCol);
  // Insertion doesn't move the row's start; positions are recomputed by walking from the row's id.
  const changed = new Set(changedIndices(before, existingAfter));
  if (changed.size > 0) {
    const rowAfter = tr.doc.nodeAt(found.pos)!;
    let pos = found.pos + 1;
    for (let i = 0, j = 0; i < rowAfter.childCount; i++) {
      const col = rowAfter.child(i);
      if (i !== newIndex) {
        if (changed.has(j)) tr.setNodeAttribute(pos, "width", existingAfter[j]);
        j++;
      }
      pos += col.nodeSize;
    }
  }
  selectStart(tr, insertPos + 1);
  return true;
}

function replaceEmpty(tr: Transaction, plan: Extract<InsertPlan, { kind: "replaceEmpty" }>): boolean {
  const found = find(tr.doc, plan.columnId, COLUMN_TYPE);
  if (!found || !allBlocks(plan.xNodes)) return false;
  const column = found.node;
  const empty = column.firstChild;
  if (column.childCount !== 1 || !empty || empty.attrs.id !== plan.emptyId || !isEmptyParagraph(empty)) return false;
  const from = found.pos + 1;
  tr.replaceWith(from, from + empty.nodeSize, plan.xNodes);
  selectStart(tr, from);
  return true;
}

// On false, `tr` may hold partial steps; the caller must discard it.
export function buildInsert(tr: Transaction, plan: InsertPlan): boolean {
  try {
    if (plan.kind === "newRow") return newRow(tr, plan);
    if (plan.kind === "addColumn") return addColumn(tr, plan);
    return replaceEmpty(tr, plan);
  } catch {
    return false;
  }
}
