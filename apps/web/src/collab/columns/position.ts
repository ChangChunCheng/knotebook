import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";

export interface PMNodeLike {
  type: { name: string };
  attrs: { readonly [key: string]: unknown };
  childCount: number;
  nodeSize: number;
  firstChild: PMNodeLike | null;
  lastChild: PMNodeLike | null;
  child(index: number): PMNodeLike;
  isTextblock: boolean;
  descendants(f: (node: PMNodeLike, pos: number) => boolean | void): void;
}

export interface ResolvedPosLike {
  depth: number;
  node(depth?: number): PMNodeLike;
  index(depth?: number): number;
  before(depth?: number): number;
}

export function isTopLevelPosition($pos: ResolvedPosLike): boolean {
  for (let d = 2; d <= $pos.depth; d++) {
    const name = $pos.node(d).type.name;
    if (name === COLUMN_TYPE || name === COLUMN_LIST_TYPE || name === "blockGroup") return false;
  }
  return true;
}

export interface ColumnContext {
  listDepth: number;
  colDepth: number;
  listPos: number;
  colIndex: number;
  blockIndex: number;
  list: PMNodeLike;
  col: PMNodeLike;
  block: PMNodeLike;
}

export function columnContextOf($pos: ResolvedPosLike): ColumnContext | null {
  let colDepth = -1;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === COLUMN_TYPE) {
      colDepth = d;
      break;
    }
  }
  if (colDepth < 0 || $pos.depth !== colDepth + 2) return null;
  const listDepth = colDepth - 1;
  const col = $pos.node(colDepth);
  const blockIndex = $pos.index(colDepth);
  return {
    listDepth,
    colDepth,
    listPos: $pos.before(listDepth),
    colIndex: $pos.index(listDepth),
    blockIndex,
    list: $pos.node(listDepth),
    col,
    block: col.child(blockIndex),
  };
}

// Whole-document walk; runs only when the key conditions hold, acceptable at typical document sizes.
export function findNodeById(doc: PMNodeLike, id: string, type?: string): { node: PMNodeLike; pos: number } | null {
  let hit: { node: PMNodeLike; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.attrs.id === id && (!type || node.type.name === type)) {
      hit = { node, pos };
      return false;
    }
  });
  return hit;
}
