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

/** `ShowSelectionExtension.showSelection(bool, key)` key: counted separately from the AI box's and BlockNote link button's keys (the extension counts per key). */
export const MOBILE_COLOR_PANEL_HIGHLIGHT_KEY = "mobileColorPanel";
export const MOBILE_COLOR_PANEL_OPEN_ATTR = "data-mobile-color-open";

const PM_DEFAULT_SCROLL_MARGIN_PX = 5;

type ScrollEdges = { top: number; right: number; bottom: number; left: number };

function edgesOf(value: number | Partial<ScrollEdges> | undefined, fallback: number): ScrollEdges {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  return { top: fallback, right: fallback, bottom: fallback, left: fallback, ...value };
}

/** The caret rect is a few px shorter than its line's bottom; this extra keeps the whole line (not just the caret) above the toolbar. */
const CARET_BREATHING_PX = 8;

/**
 * While the toolbar is up, scroll-to-caret leaves room below for keyboard + toolbar frame + `CARET_BREATHING_PX`, else the caret line at the bottom is covered.
 * Uses ProseMirror's `scrollMargin`/`scrollThreshold`, not CSS `scroll-padding` (ProseMirror computes scrolling itself and ignores it).
 * Top adds the sticky header height (`stickyTopInset`); left/right keep BlockNote's values; both props are restored on unmount (unset stays unset).
 * With no scrollable room at the document end, `MobileToolbarSpacer` supplies it.
 * When the keyboard rises while the editor has focus, scroll to the caret once; otherwise it stays under the toolbar until the next input.
 */
function useCaretClearsToolbar(editor: MobileToolbarEditor, inset: number): void {
  const bottom = inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX + CARET_BREATHING_PX;
  // The note header is pinned on phones: also clear it at the top so a caret moving up doesn't slide under it.
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
        // The view is already destroyed when the whole editor unmounts: nothing to restore.
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
 * `bottom` follows the on-screen keyboard height (`useKeyboardInset`). The outer `data-mobile-edit-toolbar` is how `NotePage` tells that focus on the toolbar still counts as editing.
 *
 * "+" mirrors BlockNote's side menu: an empty current block is used as is, otherwise an empty paragraph is inserted after it, then `openSuggestionMenu("/")`
 * (no "/" character is inserted, so a selected word or image isn't overwritten and a code block gains no "/").
 */
export function MobileEditToolbar({ editor, onCreateLink }: { editor: MobileToolbarEditor; onCreateLink?: () => void }) {
  const { t } = useTranslation();
  const { actions, editable, state, open } = useAiSession();
  const inset = useKeyboardInset();
  // `index.css` reads this flag on `<html>` to block pull-to-refresh while editing.
  useRootFlag(ROOT_FLAGS.editToolbar, true);
  const keyboardOpen = isKeyboardOpen(inset);
  const [mode, setModeState] = useState<MobileToolbarMode>("main");
  const colorOpen = mode === "color";
  // The panel replaces the keyboard: by then the keyboard is down (inset 0), so use the height remembered while it was stably open.
  const [panelHeight, setPanelHeight] = useState(panelHeightPx);

  // Leaving the panel must bring the editor (and keyboard) back: iOS only grants the keyboard inside a user gesture, so call synchronously in the click event; the selection is untouched in ProseMirror state.
  function setMode(next: MobileToolbarMode): void {
    if (mode === "color" && next !== "color") editor.focus();
    if (next === "color") setPanelHeight(panelHeightPx());
    setModeState(next);
  }

  // Remember only once the keyboard height is stable (hide and show animations finished), not a mid-animation value.
  useEffect(() => {
    if (!keyboardOpen || colorOpen) return;
    const timer = setTimeout(() => rememberKeyboardInset(inset), 200);
    return () => clearTimeout(timer);
  }, [inset, keyboardOpen, colorOpen]);

  // Measured panel height (the "Custom…" page is taller than the remembered keyboard height); until measured, use the remembered keyboard height.
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const panelFootprint = colorOpen ? (measuredHeight ?? panelHeight) : 0;
  useEffect(() => {
    if (!colorOpen) setMeasuredHeight(null);
  }, [colorOpen]);
  useEffect(() => {
    setColorPanelHeight(panelFootprint);
    return () => setColorPanelHeight(0);
  }, [panelFootprint]);

  // The user taps the text while the panel is open: the editor regains focus and the keyboard rises, so the panel must not stack on it; back to the format row.
  useEffect(() => {
    if (!colorOpen) return;
    const dom = editor.domElement;
    const back = () => setModeState("format");
    dom?.addEventListener("focusin", back);
    return () => dom?.removeEventListener("focusin", back);
  }, [colorOpen, editor]);

  // Without focus the selection isn't highlighted: while the panel is open ShowSelectionExtension draws it, and an attribute on the editor root
  // makes the style draw an outline instead (a highlight background would hide the background colour just applied; see index.css).
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
        // The view is already destroyed when the whole editor unmounts: nothing to close.
      }
    };
  }, [colorOpen, editor]);

  function insertBlock(): void {
    const block = editor.getTextCursorPosition().block;
    // The slash menu doesn't open in a code block, so an empty code block also gets a paragraph inserted after it.
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
    // Blocks without inline content (image, file…) can't be turned into an image: insert after; otherwise same path as the slash menu's image item.
    const inserted =
      block.content === undefined
        ? editor.insertBlocks([{ type: "image" }], block, "after")[0]!
        : insertOrUpdateBlockForSlashMenu(editor, { type: "image" });
    editor.getExtension(FilePanelExtension)?.showMenu(inserted.id);
    editor.getExtension(FormattingToolbarExtension)?.store.setState(false);
  }

  // mousedown is blocked, so focus stays in the editor until click: the toolbar isn't unmounted before the click.
  function hideKeyboard(): void {
    editor.domElement?.blur();
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  useCaretClearsToolbar(editor, colorOpen ? Math.max(inset, panelFootprint) : inset);
  // Same condition as the desktop AI button: with a collapsed cursor or an image selected `getSelection()` is undefined and `open()` does nothing, so the button is disabled.
  const hasBlockSelection = useEditorState({ editor, selector: ({ editor: current }) => current?.getSelection() !== undefined });
  const blockTypeIndex = useBlockTypeState(editor).selected;
  const showAi = editable && actions.length > 0;
  // The panel grows while open ("Custom…" page, measured height): the editor has no focus so ProseMirror won't scroll by itself;
  // add a scrollIntoView to bring the selection above the panel (scrollMargin was already updated by the effect above). No hasFocus condition.
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
        // The colour panel carries its own bottom padding (including the safe area); the pill and the panel are separated by mb-2.
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
            {/* Back stays pinned left while the content scrolls horizontally */}
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
