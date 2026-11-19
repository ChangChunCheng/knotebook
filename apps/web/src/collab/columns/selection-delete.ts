import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";

/**
 * Core's cross-column `getSelection().blocks` contains the column node itself, and the whole columnList when the selection starts above a row; deleting those item by item
 * would remove unselected blocks below the selection end. So column / row items expand to direct child blocks overlapping the selection; the whole row is kept only when the selection spans from above to below it.
 * Multi-selection is decided on the expanded set (core requires the clicked block to be in `blocks`, which fails across columns). A clicked block whose ancestor columnList is in the set also counts, but
 * not ordinary parent blocks: otherwise selecting one word in a parent and opening ⋮⋮ on a child would delete the parent with its unselected siblings.
 * With no column / row items the result equals core's rule.
 * Anything that would need core internals or fight core selection/undo falls back to core behaviour.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;
type SelectionDeleteEditor = Pick<AnyEditor, "prosemirrorState" | "getSelection" | "getParentBlock">;
type PMNode = AnyEditor["prosemirrorState"]["doc"];

function findBlockNode(doc: PMNode, id: string): { node: PMNode; pos: number } | undefined {
  let hit: { node: PMNode; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type.isInGroup("bnBlock") && node.attrs.id === id) {
      hit = { node, pos };
      return false;
    }
    return true;
  });
  return hit;
}

export function blockIdsInSelectionForDelete(editor: Pick<AnyEditor, "prosemirrorState">, blocks: readonly { id: string; type: string }[]): string[] {
  const { doc, selection } = editor.prosemirrorState;
  const { from, to } = selection;
  const out: string[] = [];
  const childrenInRange = (column: PMNode, columnPos: number) => {
    let start = columnPos + 1;
    column.forEach((child) => {
      const end = start + child.nodeSize;
      if (start < to && end > from) out.push(child.attrs.id as string);
      start = end;
    });
  };
  for (const block of blocks) {
    const hit = block.type === COLUMN_TYPE || block.type === COLUMN_LIST_TYPE ? findBlockNode(doc, block.id) : undefined;
    if (!hit) {
      out.push(block.id);
    } else if (block.type === COLUMN_TYPE) {
      childrenInRange(hit.node, hit.pos);
    } else if (from <= hit.pos && hit.pos + hit.node.nodeSize <= to) {
      out.push(block.id);
    } else {
      let columnPos = hit.pos + 1;
      hit.node.forEach((column) => {
        childrenInRange(column, columnPos);
        columnPos += column.nodeSize;
      });
    }
  }
  return [...new Set(out)];
}

function insideSelectedRow(editor: Pick<AnyEditor, "getParentBlock">, id: string, ids: readonly string[]): boolean {
  for (let parent = editor.getParentBlock(id); parent; parent = editor.getParentBlock(parent.id)) {
    if (parent.type === COLUMN_LIST_TYPE && ids.includes(parent.id)) return true;
  }
  return false;
}

export function blockIdsForMenuDelete(editor: SelectionDeleteEditor, clickedId: string): string[] {
  const selected = editor.getSelection()?.blocks;
  if (!selected) return [clickedId];
  const ids = blockIdsInSelectionForDelete(editor, selected);
  const multi = ids.includes(clickedId) || selected.some((b) => b.id === clickedId) || insideSelectedRow(editor, clickedId, ids);
  return multi ? ids : [clickedId];
}
