import { useMemo } from "react";
import { useBlockNoteEditor, useComponentsContext, useEditorState } from "@blocknote/react";
import { applyBlockType, blockTypeItemsFor, currentBlockTypeIndex } from "./block-type-items";

/**
 * 格式工具列的區塊類型選單，取代 BlockNote 內建的 `BlockTypeSelect`（#464）。
 * 內建版在多區塊選取時，會把選取內每個區塊（含表格、圖片等不在選單內的區塊）都換成選的類型，內容就此清空；
 * 這裡只改本身就是選單項目類型的區塊，其餘原樣保留，整批在同一個 transaction 內，並自成一個撤銷步（不跟前面的打字併在一起），一次復原全部回來。
 * 項目、順序、圖示與勾選規則與內建版相同；第一個目標區塊不是項目類型（例如表格）或編輯器唯讀時不出現。
 */
export function KnotebookBlockTypeSelect() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const items = useMemo(() => blockTypeItemsFor(editor), [editor]);
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => currentBlockTypeIndex(current, items),
  });

  if (selected === -1 || !editor.isEditable) return null;

  return (
    <Components.FormattingToolbar.Select
      className="bn-select"
      items={items.map((item, index) => {
        const Icon = item.icon;
        return {
          text: item.name,
          icon: <Icon size={16} />,
          onClick: () => {
            editor.focus();
            applyBlockType(editor, item, items);
          },
          isSelected: index === selected,
        };
      })}
    />
  );
}
