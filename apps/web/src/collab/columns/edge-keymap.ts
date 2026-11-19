/**
 * Backspace at a column's start / Delete at a column's end. Core leaves an extra empty paragraph here, removes the row's other empty columns, misplaces the block,
 * and Delete at the end of the last column of a row at the document end throws.
 * - Doesn't call `fixColumnList`: it removes all empty columns of the row, including ones left empty on purpose. A source column that became empty is deleted; when the row would be left with
 *   two columns, the other column's content replaces the row in one step (deleting the column first in two steps makes PM add an empty column back).
 * - `priority: 1000`: must run before core's Backspace/Delete chain (50); return false to hand back.
 * - `undoInputRule` is tried first: it is the first step of core's Backspace chain, which we pre-empt, so otherwise a just-fired input rule couldn't be undone.
 * - Delete excludes code blocks: core deletes an empty code block and collapses the column.
 * - Tests need a real keydown (`view.someProp("handleKeyDown", …)`); `commands.keyboardShortcut()` replays multi-step transactions and measures artifacts.
 */
import { Extension, isTextSelection, type Editor } from "@tiptap/core";
import { isEmptyColumn, removeAndInsertBlocks } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { columnContextOf, findNodeById, type ColumnContext, type PMNodeLike } from "./position";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transaction/Node types can't be imported: prosemirror-state/-model aren't apps/web dependencies
type Any = any;
type BnEditor = NonNullable<EditorRef["current"]>;

interface EdgeContext extends ColumnContext {
  atStart: boolean;
  atEnd: boolean;
}

function edgeContext(state: Editor["state"]): EdgeContext | null {
  const { selection } = state;
  if (!isTextSelection(selection) || !selection.empty) return null;
  const { $from } = selection;
  // Right after the document loads, y-prosemirror's _forceRerender can leave a TextSelection whose parent is a column at the row's start.
  if (!$from.parent.isTextblock) return null;
  const ctx = columnContextOf($from as Any);
  if (!ctx) return null;
  return { ...ctx, atStart: $from.parentOffset === 0, atEnd: $from.parentOffset === $from.parent.content.size };
}

const idOf = (node: PMNodeLike) => node.attrs.id as string;
// For a leaf such as an image, the position before it, so `Selection.near` (bias 1) selects that node.
const blockStart = (doc: Any, id: string) => {
  const b = findNodeById(doc, id, "blockContainer")!;
  return b.pos + (b.node.firstChild!.isTextblock ? 2 : 1);
};
const blockEnd = (doc: Any, id: string) => {
  const b = findNodeById(doc, id, "blockContainer")!;
  return b.pos + b.node.firstChild!.nodeSize;
};

function dropColumn(tr: Any, listId: string, colId: string): void {
  const list = findNodeById(tr.doc, listId, COLUMN_LIST_TYPE)!;
  if (list.node.childCount === 2) {
    const other = list.node.child(0).attrs.id === colId ? list.node.child(1) : list.node.child(0);
    tr.replaceWith(list.pos, list.pos + list.node.nodeSize, (other as Any).content);
    return;
  }
  const col = findNodeById(tr.doc, colId, COLUMN_TYPE)!;
  tr.delete(col.pos, col.pos + col.node.nodeSize);
}

function moveBlock(tr: Any, movedId: string, srcColId: string, tgtColId: string, listId: string, afterId: string | null): void {
  const moved = findNodeById(tr.doc, movedId, "blockContainer")!.node;
  removeAndInsertBlocks(tr, [movedId], [], { fixColumns: false });
  const target = findNodeById(tr.doc, tgtColId, COLUMN_TYPE)!;
  if (isEmptyColumn(target.node as Any)) {
    const empty = target.node.firstChild!;
    tr.replaceWith(target.pos + 1, target.pos + 1 + empty.nodeSize, moved);
  } else if (afterId === null) {
    tr.insert(target.pos + target.node.nodeSize - 1, moved);
  } else {
    const after = findNodeById(tr.doc, afterId, "blockContainer")!;
    tr.insert(after.pos + after.node.nodeSize, moved);
  }
  const src = findNodeById(tr.doc, srcColId, COLUMN_TYPE);
  if (src && isEmptyColumn(src.node as Any)) dropColumn(tr, listId, srcColId);
}

function apply(editor: BnEditor, state: Editor["state"], build: (tr: Any) => number): true {
  const SelectionCtor = state.selection.constructor as Any;
  asUndoStep(editor, () =>
    editor.transact((tr) => {
      const pos = build(tr);
      tr.setSelection(SelectionCtor.near(tr.doc.resolve(pos)));
    }),
  );
  return true;
}

export function createColumnEdgeKeymapExtension(opts: { editorRef: EditorRef }): Extension {
  return Extension.create({
    name: "knotebookColumnEdgeKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Backspace: ({ editor: tiptap }) => {
          const editor = opts.editorRef.current;
          if (!editor) return false;
          const c = edgeContext(tiptap.state);
          if (!c || !c.atStart || c.blockIndex !== 0) return false;
          if (tiptap.commands.undoInputRule()) return true;
          const listId = idOf(c.list);
          const colId = idOf(c.col);
          if (isEmptyColumn(c.col as Any)) {
            const prev = c.colIndex > 0 ? c.list.child(c.colIndex - 1) : null;
            const cursorId = prev ? idOf(prev.lastChild!) : idOf(c.list.child(1).firstChild!);
            return apply(editor, tiptap.state, (tr) => {
              dropColumn(tr, listId, colId);
              return prev ? blockEnd(tr.doc, cursorId) : blockStart(tr.doc, cursorId);
            });
          }
          if (c.colIndex === 0) return false;
          if (c.block.firstChild!.type.name !== "paragraph") return false;
          const movedId = idOf(c.block);
          const prevColId = idOf(c.list.child(c.colIndex - 1));
          return apply(editor, tiptap.state, (tr) => {
            moveBlock(tr, movedId, colId, prevColId, listId, null);
            return blockStart(tr.doc, movedId);
          });
        },
        Delete: ({ editor: tiptap }) => {
          const editor = opts.editorRef.current;
          if (!editor) return false;
          const c = edgeContext(tiptap.state);
          if (!c || !c.atEnd || c.blockIndex !== c.col.childCount - 1) return false;
          if (c.block.childCount !== 1 || c.block.firstChild!.type.name === "codeBlock") return false;
          // Last column: swallow when nothing follows the row (core would throw).
          if (c.colIndex === c.list.childCount - 1) return !tiptap.state.doc.resolve(c.listPos + c.list.nodeSize).nodeAfter;
          const listId = idOf(c.list);
          const colId = idOf(c.col);
          const curId = idOf(c.block);
          const next = c.list.child(c.colIndex + 1);
          if (isEmptyColumn(next as Any)) {
            return apply(editor, tiptap.state, (tr) => {
              dropColumn(tr, listId, idOf(next));
              return blockEnd(tr.doc, curId);
            });
          }
          const movedId = idOf(next.firstChild!);
          return apply(editor, tiptap.state, (tr) => {
            moveBlock(tr, movedId, idOf(next), colId, listId, curId);
            return findNodeById(tr.doc, curId, "blockContainer") ? blockEnd(tr.doc, curId) : blockStart(tr.doc, movedId);
          });
        },
      };
    },
  });
}
