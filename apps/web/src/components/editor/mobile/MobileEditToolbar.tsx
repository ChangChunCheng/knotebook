import { useEffect, useRef, useState } from "react";
import { useEditorState } from "@blocknote/react";
import { useTranslation } from "react-i18next";
import { insertOrUpdateBlockForSlashMenu, SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, FormattingToolbarExtension, ShowSelectionExtension } from "@blocknote/core/extensions";
import "@/i18n/mobile-toolbar-strings";
import { useAiSession } from "@/components/ai/AiSession";
import { ChevronLeft, Plus, Sparkles } from "@/components/ui/icons";
import { ImageIcon, KeyboardDown, Pilcrow, RotateCcw, RotateCw } from "@/components/ui/icons-extra";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { cn } from "@/lib/utils";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { ROOT_FLAGS, useRootFlag, useStickyTopInset } from "@/lib/page-scroll";
import { MobileToolbarButton } from "./MobileToolbarButton";
import { ColorPanel } from "./ColorPanel";
import { panelHeightPx, rememberKeyboardInset, setColorPanelHeight } from "./toolbar-footprint";
import { BlockTypeRow, FormatRow, useBlockTypeState, type MobileToolbarEditor, type MobileToolbarMode } from "./toolbar-modes";

/** `ShowSelectionExtension.showSelection(bool, key)` 的 key：與 AI 框、BlockNote 連結鈕各自的 key 分開計。 */
export const MOBILE_COLOR_PANEL_HIGHLIGHT_KEY = "mobileColorPanel";
/** 色盤開著時掛在編輯器根節點的屬性；`index.css` 靠它把選取的反白改畫成外框。 */
export const MOBILE_COLOR_PANEL_OPEN_ATTR = "data-mobile-color-open";

/** ProseMirror 沒人設定時的 `scrollMargin` 預設。 */
const PM_DEFAULT_SCROLL_MARGIN_PX = 5;

type ScrollEdges = { top: number; right: number; bottom: number; left: number };

function edgesOf(value: number | Partial<ScrollEdges> | undefined, fallback: number): ScrollEdges {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  return { top: fallback, right: fallback, bottom: fallback, left: fallback, ...value };
}

/** 游標矩形比它那一行的下緣短幾 px；多留這一段，整行（不只游標）都在工具列之上。 */
const CARET_BREATHING_PX = 8;

/**
 * 工具列在時，編輯器為了讓游標可見而捲動時，下緣要多留「鍵盤高＋工具列外框高＋游標到該行下緣的幾 px（`CARET_BREATHING_PX`）」，
 * 不然打到可視區最下面時游標那一行會被工具列蓋住。用 ProseMirror 的 `scrollMargin`／`scrollThreshold`
 * （不是 CSS `scroll-padding`：ProseMirror 自己算捲動量，不讀 scroll-padding）。
 * 改 bottom，top 在原本的值上加頁首高（`stickyTopInset`，手機上頁首釘在頂端）；左右保留 BlockNote 原本設的值，
 * 卸載時兩個 prop 照原樣還原（原本沒設就還原成沒設）。
 * 文件尾端沒有可捲的空間時靠 `MobileToolbarSpacer` 補。
 *
 * 鍵盤升起（inset 變大）且編輯器有焦點時補一次捲動到游標，不然要等下一次輸入游標才離開工具列。
 */
function useCaretClearsToolbar(editor: MobileToolbarEditor, inset: number): void {
  const bottom = inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX + CARET_BREATHING_PX;
  // 手機上捲的是文件，筆記頁首釘在頁面頂端：上緣也要讓開頁首，往上移動時游標那一行才不會鑽到頁首底下。
  const header = useStickyTopInset();
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const previous = { scrollMargin: view.props.scrollMargin, scrollThreshold: view.props.scrollThreshold };
    const margin = edgesOf(previous.scrollMargin, PM_DEFAULT_SCROLL_MARGIN_PX);
    const threshold = edgesOf(previous.scrollThreshold, 0);
    view.setProps({
      scrollMargin: { ...margin, top: margin.top + header, bottom },
      scrollThreshold: { ...threshold, top: threshold.top + header, bottom },
    });
    return () => {
      try {
        view.setProps(previous);
      } catch {
        // 整個編輯器一起卸載時 view 已銷毀，沒有東西可還原。
      }
    };
  }, [editor, bottom, header]);

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
export function MobileEditToolbar({ editor, onCreateLink }: { editor: MobileToolbarEditor; onCreateLink?: () => void }) {
  const { t } = useTranslation();
  const { actions, editable, state, open } = useAiSession();
  const inset = useKeyboardInset();
  // 編輯中擋下拉重新整理：`index.css` 看 `<html>` 上的旗標（見 `ROOT_FLAGS`）。
  useRootFlag(ROOT_FLAGS.editToolbar, true);
  const keyboardOpen = isKeyboardOpen(inset);
  const [mode, setModeState] = useState<MobileToolbarMode>("main");
  const colorOpen = mode === "color";
  // 色盤取代鍵盤的位置：進色盤時鍵盤已收（inset 變 0），所以用鍵盤穩定開著時記下的高度。
  const [panelHeight, setPanelHeight] = useState(panelHeightPx);

  // 離開色盤要把編輯器叫回來（鍵盤跟著回來）：iOS 只在使用者手勢內給鍵盤，所以在點擊事件裡同步呼叫；選取在 ProseMirror 狀態裡沒動。
  function setMode(next: MobileToolbarMode): void {
    if (mode === "color" && next !== "color") editor.focus();
    if (next === "color") setPanelHeight(panelHeightPx());
    setModeState(next);
  }

  // 鍵盤高度穩定（收起動畫與升起動畫都過了）才記，不然會記到動畫中途的值。
  useEffect(() => {
    if (!keyboardOpen || colorOpen) return;
    const timer = setTimeout(() => rememberKeyboardInset(inset), 200);
    return () => clearTimeout(timer);
  }, [inset, keyboardOpen, colorOpen]);

  // 色盤實際量到的高度（「自訂…」頁比記下的鍵盤高還高）；沒量到之前用記下的鍵盤高。
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const panelFootprint = colorOpen ? (measuredHeight ?? panelHeight) : 0;
  useEffect(() => {
    if (!colorOpen) setMeasuredHeight(null);
  }, [colorOpen]);
  useEffect(() => {
    setColorPanelHeight(panelFootprint);
    return () => setColorPanelHeight(0);
  }, [panelFootprint]);

  // 色盤開著時使用者點內文：編輯器取回焦點、鍵盤升起，色盤不該再疊在鍵盤上，回到格式列。
  useEffect(() => {
    if (!colorOpen) return;
    const dom = editor.domElement;
    const back = () => setModeState("format");
    dom?.addEventListener("focusin", back);
    return () => dom?.removeEventListener("focusin", back);
  }, [colorOpen, editor]);

  // 編輯器失焦後選取不再反白：色盤開著時用 ShowSelectionExtension 補，並在編輯器根節點掛屬性，
  // 讓樣式改畫外框（反白的底色會蓋住剛套上的背景色，見 index.css）。
  useEffect(() => {
    if (!colorOpen) return;
    const dom = editor.domElement;
    const extension = editor.getExtension(ShowSelectionExtension);
    extension?.showSelection(true, MOBILE_COLOR_PANEL_HIGHLIGHT_KEY);
    dom?.setAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR, "");
    return () => {
      dom?.removeAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR);
      try {
        extension?.showSelection(false, MOBILE_COLOR_PANEL_HIGHLIGHT_KEY);
      } catch {
        // 整個編輯器一起卸載時 view 已銷毀，沒有東西可關。
      }
    };
  }, [colorOpen, editor]);

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

  useCaretClearsToolbar(editor, colorOpen ? Math.max(inset, panelFootprint) : inset);
  // 與桌機 AI 鈕同一個條件：游標收合或選到圖片時 `getSelection()` 是 undefined，`open()` 不會有反應，所以鈕停用。
  const hasBlockSelection = useEditorState({ editor, selector: ({ editor: current }) => current?.getSelection() !== undefined });
  const blockTypeIndex = useBlockTypeState(editor).selected;
  const showAi = editable && actions.length > 0;
  // 色盤開著時高度變大（進「自訂…」頁、量到實際高度）：編輯器沒有焦點，ProseMirror 不會自己捲，
  // 所以補一筆 scrollIntoView 把選取捲到色盤上方（scrollMargin 已在上面的 effect 先更新）。不加 hasFocus 條件。
  const previousFootprint = useRef(panelFootprint);
  useEffect(() => {
    const before = previousFootprint.current;
    previousFootprint.current = panelFootprint;
    if (!colorOpen || panelFootprint <= before) return;
    const view = editor.prosemirrorView;
    view?.dispatch(view.state.tr.scrollIntoView());
  }, [editor, colorOpen, panelFootprint]);

  const modeProps = { editor, mode, setMode, onCreateLink };

  return (
    <div
      data-mobile-edit-toolbar=""
      data-mobile-toolbar-mode={mode}
      role="toolbar"
      aria-label={t("mobileToolbar.label")}
      style={{ bottom: inset }}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center px-2",
        // 色盤自己帶底距（含 safe area），膠囊與色盤之間用 mb-2 隔開
        colorOpen ? "pb-0" : keyboardOpen ? "pb-2" : "pb-[calc(0.5rem+env(safe-area-inset-bottom))]",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex h-[52px] min-w-0 max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-card px-1 shadow-lg [scrollbar-width:none]",
          colorOpen && "mb-2",
        )}
      >
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
            <MobileToolbarButton label={t("mobileToolbar.blockType")} disabled={blockTypeIndex === -1} onClick={() => setMode("blockType")}>
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
            {/* 內容橫捲時「返回」釘在左邊，不會捲出畫面 */}
            <span className="sticky left-0 z-10 flex shrink-0 rounded-full bg-card">
              <MobileToolbarButton label={t("mobileToolbar.back")} onClick={() => setMode(mode === "color" ? "format" : "main")}>
                <ChevronLeft aria-hidden="true" className="h-5 w-5" />
              </MobileToolbarButton>
            </span>
            {(mode === "format" || mode === "color") && <FormatRow {...modeProps} />}
            {mode === "blockType" && <BlockTypeRow {...modeProps} />}
          </>
        )}
      </div>
      {colorOpen && <ColorPanel editor={editor} height={panelHeight} keyboardOpen={keyboardOpen} inset={inset} onMeasure={setMeasuredHeight} />}
    </div>
  );
}
