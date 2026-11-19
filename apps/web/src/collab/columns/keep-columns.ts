import { removeAndInsertBlocks, type Block, type BlockIdentifier, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";

/**
 * Our own removals / replacements skip column cleanup: core's `removeBlocks` / `replaceBlocks` run `fixColumnList`, which removes an emptied column and flattens a one-column row.
 * `removeAndInsertBlocks(…, { fixColumns: false })` keeps the columns (an emptied one gets an empty paragraph from PM's replace fitter). In collaboration, B deleting the image
 * in the sibling column with core's `removeBlocks` would flatten the row and eat A's text in the remaining column. (guard: `keep-columns.guard.test.ts`)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyPartialBlock = PartialBlock<any, any, any>;

export function removeBlocksKeepColumns(editor: Pick<AnyEditor, "transact">, ids: BlockIdentifier[]): AnyBlock[] {
  return editor.transact((tr) => removeAndInsertBlocks(tr, ids, [], { fixColumns: false }).removedBlocks);
}

export function replaceBlocksKeepColumns(
  editor: Pick<AnyEditor, "transact">,
  ids: BlockIdentifier[],
  blocks: AnyPartialBlock[],
): { insertedBlocks: AnyBlock[]; removedBlocks: AnyBlock[] } {
  return editor.transact((tr) => removeAndInsertBlocks(tr, ids, blocks, { fixColumns: false }));
}
