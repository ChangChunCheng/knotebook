import { editorHasBlockWithType } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
type AnyBlockNoteEditor = BlockNoteEditor<any, any, any>;

export type BlockTypeItem = ReturnType<typeof blockTypeSelectItems>[number];

/** 選取所在的區塊；沒有選取時是游標所在的區塊（與 BlockNote 格式工具列同一個規則）。 */
export function targetBlocks(editor: AnyBlockNoteEditor) {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}

/** 區塊類型選單的項目（`blockTypeSelectItems`），再依 schema 過濾；過濾邏輯同 BlockNote 的 `BlockTypeSelect`。 */
export function blockTypeItemsFor(editor: AnyBlockNoteEditor): BlockTypeItem[] {
  return blockTypeSelectItems(editor.dictionary).filter((item) =>
    editorHasBlockWithType(
      editor,
      item.type,
      Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as Record<string, "string" | "number" | "boolean">,
    ),
  );
}

/**
 * 第一個目標區塊對應到哪一項（-1＝沒有任何一項符合，例如表格、程式碼區塊、圖片）。
 * -1 代表目前區塊不能換類型：對它套用任何一項都會把表格或程式碼區塊的內容清掉。
 */
export function currentBlockTypeIndex(editor: AnyBlockNoteEditor, items: BlockTypeItem[]): number {
  const first = targetBlocks(editor)[0];
  if (!first) return -1;
  return items.findIndex(
    (item) => item.type === first.type && Object.entries(item.props ?? {}).every(([name, value]) => (first.props as Record<string, unknown>)[name] === value),
  );
}

/**
 * 把 `item` 套用到目標區塊（選取，沒有選取就是游標所在的區塊），在同一個 transaction 內完成。
 * 只改本身型別就在 `items` 裡的區塊；表格、程式碼區塊、圖片不動，不然內容會被清掉。
 */
export function applyBlockType(editor: AnyBlockNoteEditor, item: BlockTypeItem, items: BlockTypeItem[]): void {
  editor.transact(() => {
    for (const block of targetBlocks(editor)) {
      if (!items.some((candidate) => candidate.type === block.type)) continue;
      editor.updateBlock(block, { type: item.type as never, props: item.props as never });
    }
  });
}
