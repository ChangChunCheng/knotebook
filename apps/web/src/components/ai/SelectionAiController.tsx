import { useMemo } from "react";
import { flip, offset, shift } from "@floating-ui/react";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbarController,
  useBlockNoteEditor,
  useEditorState,
  useExtensionState,
  type FloatingUIOptions,
} from "@blocknote/react";
import { isNonTextSelection, selectionInsideAnchor } from "@/ai/selection";
import { useIsPhone } from "@/lib/layout-tiers";
import { activeAnchorOf, useAiSession } from "./AiSession";
import { AiToolbar } from "./AiToolbar";
import { SelectionAiBox } from "./SelectionAiBox";

/**
 * 格式工具列外面那層 floating-ui 元素（包住工具列的 div，z-index 40）的標記：拖放中關得到它的指標命中（`index.css` 的 `.kb-dragging`）。
 * ⋮⋮ 拖曳開始時 core 選取被拖的 block，工具列出現在它正上方；不關的話，放開在工具列上時 drop 會被它接走。
 * 不放 `style`：`FormattingToolbarController` 是 `{ style: { zIndex: 40 }, ...elementProps }`，傳了 `style` 就整個蓋掉 z-index。
 */
export const FORMATTING_TOOLBAR_ELEMENT_PROPS = { "data-kb-formatting-toolbar-popover": "" } as FloatingUIOptions["elementProps"];

/** 手機編輯工具列的外框高度（膠囊 52＋下方留白 8）：浮動格式工具列翻到下方、編輯器捲動時要避開它。 */
export const PHONE_EDIT_TOOLBAR_CLEARANCE_PX = 60;

/**
 * 浮動格式工具列的定位：與 BlockNote 預設相同（offset 10、shift、flip），但手機時 flip 的下緣內縮 `bottomPadding`，
 * 工具列不會翻到手機編輯工具列底下。floating-ui 的視窗邊界本來就取視覺視窗，止於螢幕鍵盤上緣，所以這裡只扣工具列本身、不再加鍵盤高。
 */
export function formattingToolbarMiddleware(bottomPadding: number) {
  return [offset(10), shift(), bottomPadding > 0 ? flip({ padding: { bottom: bottomPadding } }) : flip()];
}

/**
 * 框選 AI 的掛載點（#263）：`NoteEditor` 把它當 `NoteEditorView` 的 children 傳進 `<BlockNoteView>`，它是 **formatting toolbar
 * controller 與 `SelectionAiBox` 的唯一擁有者**——`NoteEditorView` 不碰 AI context。
 *
 * 手機（< 640）選文字時不出浮動格式工具列（觸控選取時它會蓋住選取與系統選單）；選到圖片、檔案、儲存格時照舊出。框選 AI 框照常，由手機編輯工具列的 AI 鈕開。
 *
 * 工具列壓制：`toolbarOpen = toolbarStoreOpen && !(phone && !nonTextSelection) && !(boxOpen && selectionInsideTarget)`。`toolbarStoreOpen` 是上游 store
 * （pointerdown 期間恆為 false），**只用於這條壓制公式**；框的自動關閉用 `ai/selection.ts` 的 `toolbarWouldShow`（在 AiSession 裡）。
 * 覆寫 `useFloatingOptions.open` 即可收起：GenericPopover 以 floating 的 open 決定掛不掛（jsdom 實測，收合有約 270ms 轉場）。
 */
export function SelectionAiController() {
  const editor = useBlockNoteEditor();
  const phone = useIsPhone();
  const { state } = useAiSession();
  const flipBottomPadding = phone ? PHONE_EDIT_TOOLBAR_CLEARANCE_PX : 0;
  const toolbarStoreOpen = useExtensionState(FormattingToolbarExtension, { editor });
  const anchor = activeAnchorOf(state);
  const boxOpen = state.phase !== "idle";
  const insideTarget = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current !== null && anchor !== null && current.transact((tr) => selectionInsideAnchor(tr, anchor.blockIds)),
  });
  const nonTextSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => current !== null && current.transact((tr) => isNonTextSelection(tr)),
  });
  // 手機上選文字不出浮動工具列；選到圖片、檔案或儲存格時照舊出（那排的替換、刪除、合併等項沒有別的入口）。
  const hiddenOnPhone = phone && !nonTextSelection;
  const toolbarOpen = toolbarStoreOpen && !hiddenOnPhone && !(boxOpen && insideTarget);
  // FormattingToolbarController 內部的 useMemo 以這個物件的身分為依賴——每次 render 新建會讓它每次重算。
  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: { open: toolbarOpen, ...(flipBottomPadding > 0 && { middleware: formattingToolbarMiddleware(flipBottomPadding) }) },
      elementProps: FORMATTING_TOOLBAR_ELEMENT_PROPS,
    }),
    [toolbarOpen, flipBottomPadding],
  );

  return (
    <>
      <FormattingToolbarController formattingToolbar={AiToolbar} floatingUIOptions={floatingUIOptions} />
      <SelectionAiBox />
    </>
  );
}
