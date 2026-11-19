import { editorHasBlockWithType } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";
import { asUndoStep } from "@/collab/columns/undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple (repo convention)
type AnyBlockNoteEditor = BlockNoteEditor<any, any, any>;

export type BlockTypeItem = ReturnType<typeof blockTypeSelectItems>[number];

// Same rule as BlockNote's formatting toolbar.
export function targetBlocks(editor: AnyBlockNoteEditor) {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}

// Same filter as BlockNote's BlockTypeSelect.
export function blockTypeItemsFor(editor: AnyBlockNoteEditor): BlockTypeItem[] {
  return blockTypeSelectItems(editor.dictionary).filter((item) =>
    editorHasBlockWithType(
      editor,
      item.type,
      Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as Record<string, "string" | "number" | "boolean">,
    ),
  );
}

/** -1 = no item matches (table, code block, image): applying any item to those would wipe their content. */
export function currentBlockTypeIndex(editor: AnyBlockNoteEditor, items: BlockTypeItem[]): number {
  const first = targetBlocks(editor)[0];
  if (!first) return -1;
  return items.findIndex(
    (item) => item.type === first.type && Object.entries(item.props ?? {}).every(([name, value]) => (first.props as Record<string, unknown>)[name] === value),
  );
}

/** One transaction and its own undo step. Only blocks whose type is already in `items` change; tables, code blocks and images would lose their content. */
export function applyBlockType(editor: AnyBlockNoteEditor, item: BlockTypeItem, items: BlockTypeItem[]): void {
  asUndoStep(editor, () =>
    editor.transact(() => {
      for (const block of targetBlocks(editor)) {
        if (!items.some((candidate) => candidate.type === block.type)) continue;
        editor.updateBlock(block, { type: item.type as never, props: item.props as never });
      }
    }),
  );
}
