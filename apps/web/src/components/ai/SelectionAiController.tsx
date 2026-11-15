import { useMemo } from "react";
import { flip, offset, shift, size } from "@floating-ui/react";
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

/** 手機浮動格式工具列離視窗左右邊緣至少留這麼多。 */
export const PHONE_FLOATING_TOOLBAR_EDGE_PX = 8;

/**
 * 浮動格式工具列的定位：與 BlockNote 預設相同（offset 10、shift、flip），但手機時 flip 的下緣內縮 `bottomPadding`，
 * 工具列不會翻到手機編輯工具列底下。floating-ui 的視窗邊界本來就取視覺視窗，止於螢幕鍵盤上緣，所以這裡只扣工具列本身、不再加鍵盤高。
 *
 * 手機另外限制寬度：工具列的按鈕排成一列，比窄視窗（320）還寬時會伸出視窗右緣；寬度上限 `100vw - 16px`，放不下的部分由內層 `.bn-toolbar` 自己橫捲（這裡不能設 overflow：overflow-x 不是 visible 時 overflow-y 也不再是 visible，下拉選單與面板會被裁掉），
 * 並讓 shift 左右各留 8px。size 排在 shift 前面，shift 才用限制後的寬度算位置。shift 的邊界取整個視窗（`document.documentElement`），
 * 不取預設的裁切祖先：內文卡左右各有一段外距，工具列放進卡的內側會比卡還寬而無處可放。
 */
export function formattingToolbarMiddleware(bottomPadding: number) {
  if (bottomPadding <= 0) return [offset(10), shift(), flip()];
  return [
    offset(10),
    size({
      apply({ elements }) {
        elements.floating.style.maxWidth = `calc(100vw - ${PHONE_FLOATING_TOOLBAR_EDGE_PX * 2}px)`;
      },
    }),
    shift({ boundary: document.documentElement, padding: { left: PHONE_FLOATING_TOOLBAR_EDGE_PX, right: PHONE_FLOATING_TOOLBAR_EDGE_PX } }),
    flip({ padding: { bottom: bottomPadding } }),
  ];
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
