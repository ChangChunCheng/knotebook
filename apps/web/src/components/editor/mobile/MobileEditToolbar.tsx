import { useEffect, useRef, useState } from "react";
import { useEditorState } from "@blocknote/react";
import { useTranslation } from "react-i18next";
import { insertOrUpdateBlockForSlashMenu, SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, FormattingToolbarExtension } from "@blocknote/core/extensions";
import "@/i18n/mobile-toolbar-strings";
import { useAiSession } from "@/components/ai/AiSession";
import { ChevronLeft, Plus, Sparkles } from "@/components/ui/icons";
import { ImageIcon, KeyboardDown, Pilcrow, RotateCcw, RotateCw } from "@/components/ui/icons-extra";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { cn } from "@/lib/utils";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { MobileToolbarButton } from "./MobileToolbarButton";
import { BlockTypeRow, ColorPanel, FormatRow, type MobileToolbarEditor, type MobileToolbarMode } from "./toolbar-modes";

/** ProseMirror 沒人設定時的 `scrollMargin` 預設。 */
const PM_DEFAULT_SCROLL_MARGIN_PX = 5;

type ScrollEdges = { top: number; right: number; bottom: number; left: number };

function edgesOf(value: number | Partial<ScrollEdges> | undefined, fallback: number): ScrollEdges {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  return { top: fallback, right: fallback, bottom: fallback, left: fallback, ...value };
}

/**
 * 工具列在時，編輯器為了讓游標可見而捲動時，下緣要多留「鍵盤高＋工具列外框高」，
 * 不然打到可視區最下面時游標那一行會被工具列蓋住。用 ProseMirror 的 `scrollMargin`／`scrollThreshold`
 * （不是 CSS `scroll-padding`：ProseMirror 自己算捲動量，不讀 scroll-padding）。
 * 只改 bottom：其餘邊保留 BlockNote 原本設的值，卸載時兩個 prop 照原樣還原（原本沒設就還原成沒設）。
 * 文件尾端沒有可捲的空間時靠 `MobileToolbarSpacer` 補。
 *
 * 鍵盤升起（inset 變大）且編輯器有焦點時補一次捲動到游標，不然要等下一次輸入游標才離開工具列。
 */
function useCaretClearsToolbar(editor: MobileToolbarEditor, inset: number): void {
  const bottom = inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX;
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const previous = { scrollMargin: view.props.scrollMargin, scrollThreshold: view.props.scrollThreshold };
    view.setProps({
      scrollMargin: { ...edgesOf(previous.scrollMargin, PM_DEFAULT_SCROLL_MARGIN_PX), bottom },
      scrollThreshold: { ...edgesOf(previous.scrollThreshold, 0), bottom },
    });
    return () => {
      try {
        view.setProps(previous);
      } catch {
        // 整個編輯器一起卸載時 view 已銷毀，沒有東西可還原。
      }
    };
  }, [editor, bottom]);

  const previousInset = useRef(inset);
  useEffect(() => {
    const before = previousInset.current;
    previousInset.current = inset;
    if (inset <= before) return;
    const view = editor.prosemirrorView;
    if (view?.hasFocus()) view.dispatch(view.state.tr.scrollIntoView());
  }, [editor, inset]);
}

/**
 * 手機（< 640）編輯中浮在鍵盤正上方的工具列：膠囊、左右各留 8px、可橫捲、每顆 44×44。
 * `bottom` 取螢幕鍵盤的高度（`useKeyboardInset`）；鍵盤收起時底下補 safe area。
 *
 * 有「模式」：主列放 AI、插入、Aa、圖片、¶、復原、重做、收起鍵盤；Aa 與 ¶ 不開面板，而是原地把整條換成
 * 「返回＋該模式的內容」（`toolbar-modes.tsx`）。所有按鈕按下都不搶編輯器的焦點（見 `MobileToolbarButton`）。
 * 最外層的 `data-mobile-edit-toolbar` 是 `NotePage` 判斷「焦點在工具列上仍算編輯中」的標記。
 *
 * 新增區塊用「＋」：照 BlockNote 側選單的「＋」——游標所在的區塊是空的就在那裡，否則先在後面插一段空段落，
 * 然後 `openSuggestionMenu("/")`（不插 `/` 字元，所以不會蓋掉選取的字或圖片，程式碼區塊裡也不會多一個 `/`）。
 */
export function MobileEditToolbar({ editor }: { editor: MobileToolbarEditor }) {
  const { t } = useTranslation();
  const { actions, editable, state, open } = useAiSession();
  const inset = useKeyboardInset();
  const keyboardOpen = isKeyboardOpen(inset);
  const [mode, setMode] = useState<MobileToolbarMode>("main");

  function insertBlock(): void {
    const block = editor.getTextCursorPosition().block;
    // 程式碼區塊裡 slash 選單不會開，所以空的程式碼區塊也走「後面插一段」。
    const isEmpty = block.type !== "codeBlock" && Array.isArray(block.content) && block.content.length === 0;
    if (isEmpty) {
      editor.setTextCursorPosition(block);
    } else {
      const inserted = editor.insertBlocks([{ type: "paragraph" }], block, "after")[0]!;
      editor.setTextCursorPosition(inserted);
    }
    editor.getExtension(SuggestionMenu)?.openSuggestionMenu("/");
  }

  function insertImage(): void {
    const block = editor.getTextCursorPosition().block;
    // 沒有內文的區塊（圖片、檔案…）不能被換成圖片，直接插在後面；其餘與 slash 選單的圖片項同一條路。
    const inserted =
      block.content === undefined
        ? editor.insertBlocks([{ type: "image" }], block, "after")[0]!
        : insertOrUpdateBlockForSlashMenu(editor, { type: "image" });
    editor.getExtension(FilePanelExtension)?.showMenu(inserted.id);
    editor.getExtension(FormattingToolbarExtension)?.store.setState(false);
  }

  // 焦點留在編輯器到 click 才離開（mousedown 被擋），工具列不會在 click 之前就被卸載。
  function hideKeyboard(): void {
    editor.domElement?.blur();
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  useCaretClearsToolbar(editor, inset);
  // 與桌機 AI 鈕同一個條件：游標收合或選到圖片時 `getSelection()` 是 undefined，`open()` 不會有反應，所以鈕停用。
  const hasBlockSelection = useEditorState({ editor, selector: ({ editor: current }) => current?.getSelection() !== undefined });
  const showAi = editable && actions.length > 0;
  const modeProps = { editor, setMode };

  return (
    <div
      data-mobile-edit-toolbar=""
      data-mobile-toolbar-mode={mode}
      role="toolbar"
      aria-label={t("mobileToolbar.label")}
      style={{ bottom: inset }}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-40 flex justify-center px-2",
        keyboardOpen ? "pb-2" : "pb-[calc(0.5rem+env(safe-area-inset-bottom))]",
      )}
    >
      <div className="pointer-events-auto flex h-[52px] min-w-0 max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-card px-1 shadow-lg [scrollbar-width:none]">
        {mode === "main" ? (
          <>
            {showAi && (
              <MobileToolbarButton label={t("ai.toolbar.trigger")} disabled={state.phase === "streaming" || !hasBlockSelection} onClick={() => open()}>
                <Sparkles aria-hidden="true" className="h-5 w-5" />
              </MobileToolbarButton>
            )}
            <MobileToolbarButton label={t("mobileToolbar.insert")} onClick={insertBlock}>
              <Plus aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.format")} onClick={() => setMode("format")}>
              <span aria-hidden="true" className="text-base font-semibold">
                Aa
              </span>
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.image")} onClick={insertImage}>
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.blockType")} onClick={() => setMode("blockType")}>
              <Pilcrow aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.undo")} onClick={() => editor.undo()}>
              <RotateCcw aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.redo")} onClick={() => editor.redo()}>
              <RotateCw aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            <MobileToolbarButton label={t("mobileToolbar.hideKeyboard")} onClick={hideKeyboard}>
              <KeyboardDown aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
          </>
        ) : (
          <>
            <MobileToolbarButton label={t("mobileToolbar.back")} onClick={() => setMode(mode === "color" ? "format" : "main")}>
              <ChevronLeft aria-hidden="true" className="h-5 w-5" />
            </MobileToolbarButton>
            {mode === "format" && <FormatRow {...modeProps} />}
            {mode === "color" && <ColorPanel {...modeProps} />}
            {mode === "blockType" && <BlockTypeRow {...modeProps} />}
          </>
        )}
      </div>
    </div>
  );
}
