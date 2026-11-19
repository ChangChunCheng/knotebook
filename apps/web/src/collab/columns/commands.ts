import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { replaceBlocksKeepColumns } from "./keep-columns";
import { findNodeById } from "./position";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyPartialBlock = PartialBlock<any, any, any>;

export function canInsertColumns(editor: AnyEditor): boolean {
  const { block } = editor.getTextCursorPosition();
  return block.type !== "table" && editor.getParentBlock(block.id) === undefined;
}

// A block with children isn't empty: replacing it would lose them, so the row is inserted after it instead.
function isEmptyParagraph(block: { type: string; content?: unknown; children: unknown[] }): boolean {
  return block.type === "paragraph" && Array.isArray(block.content) && block.content.length === 0 && block.children.length === 0;
}

export function insertColumns(editor: AnyEditor, n: 2 | 3 | 4): string {
  return asUndoStep(editor, () =>
    editor.transact((tr) => {
      const { block } = editor.getTextCursorPosition();
      const newRow: AnyPartialBlock = {
        type: COLUMN_LIST_TYPE,
        children: Array.from({ length: n }, () => ({ type: COLUMN_TYPE, props: { width: 1 }, children: [{ type: "paragraph" }] })),
      };
      const inserted = isEmptyParagraph(block)
        ? replaceBlocksKeepColumns(editor, [block.id], [newRow]).insertedBlocks[0]!
        : editor.insertBlocks([newRow], block.id, "after")[0]!;
      // A row at the end of the document can't be left with the keyboard.
      if (tr.doc.firstChild?.lastChild?.attrs.id === inserted.id) editor.insertBlocks([{ type: "paragraph" }], inserted.id, "after");
      editor.setTextCursorPosition(inserted.children[0]!.children[0]!.id, "start");
      return inserted.id;
    }),
  );
}

export function isInColumn(editor: AnyEditor, blockId: string): boolean {
  return editor.getParentBlock(blockId)?.type === COLUMN_TYPE;
}

export function ungroupColumns(editor: AnyEditor, blockId: string): boolean {
  if (!isInColumn(editor, blockId)) return false;
  const rowId = editor.getParentBlock(editor.getParentBlock(blockId)!.id)!.id;
  return asUndoStep(editor, () =>
    editor.transact((tr) => {
      const hit = findNodeById(tr.doc, rowId, COLUMN_LIST_TYPE);
      const list = hit && tr.doc.nodeAt(hit.pos);
      if (!hit || !list) return false;
      const all: NonNullable<typeof list>[] = [];
      list.forEach((col) => col.forEach((container) => void all.push(container)));
      const kept = all.filter(
        (container) => !(container.childCount === 1 && container.firstChild!.type.name === "paragraph" && container.firstChild!.content.size === 0),
      );
      if (kept.length === 0) kept.push(all[0]!);
      tr.replaceWith(hit.pos, hit.pos + list.nodeSize, kept);
      editor.setTextCursorPosition(kept[0]!.attrs.id as string, "start");
      return true;
    }),
  );
}
