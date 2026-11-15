import type { BlockNoteEditor } from "@blocknote/core";
import { useEditorState } from "@blocknote/react";
import { MobileToolbarButton } from "./MobileToolbarButton";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
export type MobileToolbarEditor = BlockNoteEditor<any, any, any>;

/**
 * 手機編輯工具列的模式：主列、格式（Aa）、顏色（格式列裡的顏色鈕）、區塊類型（¶）。
 * 非主列的模式由 `MobileEditToolbar` 在最前面放「返回」，其後渲染這裡對應的內容；
 * 內容元件只管自己的按鈕（用 `MobileToolbarButton`，按下不搶焦點）。
 */
export type MobileToolbarMode = "main" | "format" | "color" | "blockType";

export interface ModeRowProps {
  editor: MobileToolbarEditor;
  /** 切到別的模式（例如格式列的顏色鈕切到 `"color"`）；回主列用 `"main"`。 */
  setMode(mode: MobileToolbarMode): void;
}

/** 格式列：文字樣式、連結、對齊、縮排與顏色鈕。 */
export function FormatRow({ editor }: ModeRowProps) {
  const bold = useEditorState({ editor, selector: ({ editor: current }) => current?.getActiveStyles().bold === true });
  return (
    <MobileToolbarButton
      label={editor.dictionary.formatting_toolbar.bold.tooltip}
      pressed={bold}
      onClick={() => editor.toggleStyles({ bold: true })}
    >
      <span aria-hidden="true" className="text-base font-bold">
        B
      </span>
    </MobileToolbarButton>
  );
}

/** 顏色面板：文字色、背景色兩列與「自訂…」。 */
export function ColorPanel(props: ModeRowProps) {
  void props;
  return null;
}

/** 區塊類型列：與桌機區塊類型選單同一份項目。 */
export function BlockTypeRow(props: ModeRowProps) {
  void props;
  return null;
}
