import { SuggestionMenu } from "@blocknote/core";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import { getTourNoteEditor, setTourTransactionFilter, type TourEditor } from "@/lib/tour-bridge";
import { findFormattingToolbarButton, findTourTarget } from "@/lib/tour-find";
import type { TourTargetId } from "@/lib/tour-targets";

/**
 * The real menu is opened in the sample note's editor without writing the document: the cursor goes into the last empty paragraph and the menu opens with `deleteTriggerCharacter: false`, so the trigger character never enters the doc and reload, closing the tab or Back leave nothing (no version or undo entry).
 * While demoing, the editor's transaction filter (`setTourTransactionFilter`) is on: IME composition can only be blocked cleanly at transaction level. It is a flag on a permanent plugin; no plugin is registered or removed during the demo (dynamic registration breaks an open menu's state).
 * `stopLiveTrigger` (from the step's `leave`) is idempotent and may be called without a start. The AI step opens no menu: one transaction selects the demo sentence so the format toolbar appears by itself.
 * Focus in the editor raises the on-screen keyboard on touch, covering half the screen and pushing the page up; typing isn't accepted during a demo anyway, so `inputmode="none"` is set on the editable element before focusing and restored on leave (removed if absent before). Blurring isn't used: the menu closes on editor blur.
 */

export type TourTrigger = "[[" | "/";

interface Saved {
  from: number;
  to: number;
}

/** The editor being demoed; keyed by editor so nothing is left behind after the editor unmounts. */
const active = new WeakMap<TourEditor, Saved>();

function menuOf(editor: TourEditor) {
  return editor.getExtension(SuggestionMenu);
}

function lastBlockIsEmptyParagraph(editor: TourEditor): boolean {
  const last = editor.document[editor.document.length - 1];
  if (last === undefined || last.type !== "paragraph" || last.children.length > 0) return false;
  const content: unknown = last.content;
  return Array.isArray(content) && content.every((node: { type?: string; text?: string }) => node.type === "text" && (node.text ?? "") === "");
}

/** Computed once at tour start; a step that can't be demoed points at the finished artifact already in the note. */
export function canRunLiveStop(noteId: string): boolean {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return false;
  try {
    return editor.isEditable && lastBlockIsEmptyParagraph(editor);
  } catch (err) {
    // Called in the start flow: an unreadable document means "can't demo" instead of failing to start the tour.
    console.error(err);
    return false;
  }
}

/** The element, not the editor, is recorded: on leave the editor may already be unregistered or temporarily unmounted (reports destroyed, then remounts onto the same element), yet the attribute must still be restored. */
const suppressed = new Map<string, { dom: HTMLElement; previous: string | null }>();

function suppressKeyboard(noteId: string, editor: TourEditor): void {
  if (suppressed.has(noteId)) return;
  const dom = editor._tiptapEditor.view.dom;
  suppressed.set(noteId, { dom, previous: dom.getAttribute("inputmode") });
  dom.setAttribute("inputmode", "none");
}

/** Blur first if focus is still inside: swapping a focused element back to a keyboard-raising `inputmode` may summon the keyboard on touch (the menu is already closed, so blur doesn't affect the demo; a later step that needs the editor refocuses). */
function restoreKeyboard(noteId: string): void {
  const saved = suppressed.get(noteId);
  if (saved === undefined) return;
  suppressed.delete(noteId);
  const { dom, previous } = saved;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && dom.contains(focused)) focused.blur();
  if (previous === null) dom.removeAttribute("inputmode");
  else dom.setAttribute("inputmode", previous);
}

/** Both menus share one plugin, so also compare which trigger character opened it. */
export function isTriggerMenuShown(editor: TourEditor, trigger: TourTrigger): boolean {
  const menu = menuOf(editor);
  return menu?.shown() === true && menu.store.state?.triggerCharacter === trigger;
}

/** Opening the menu moves focus into the editor and scrolls the caret into view. Repeated calls do nothing. */
export function startTourTrigger(editor: TourEditor, trigger: TourTrigger): boolean {
  if (active.has(editor)) return isTriggerMenuShown(editor, trigger);
  const menu = menuOf(editor);
  const last = editor.document[editor.document.length - 1];
  if (menu === undefined || last === undefined) return false;
  const { from, to } = editor._tiptapEditor.state.selection;
  active.set(editor, { from, to });
  editor.setTextCursorPosition(last, "start");
  menu.openSuggestionMenu(trigger, { deleteTriggerCharacter: false });
  return menu.shown();
}

/** Closes the menu (if still open) and restores the pre-demo selection; a no-op if never started or repeated. Doesn't touch focus. */
export function stopTourTrigger(editor: TourEditor): void {
  const saved = active.get(editor);
  if (saved === undefined) return;
  active.delete(editor);
  const menu = menuOf(editor);
  if (menu?.shown() === true) menu.closeMenu();
  if (editor._tiptapEditor.isDestroyed) return;
  editor._tiptapEditor.commands.setTextSelection({ from: saved.from, to: saved.to });
}

export function startLiveTrigger(noteId: string, trigger: TourTrigger): void {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return;
  setTourTransactionFilter(noteId, true);
  suppressKeyboard(noteId, editor);
  startTourTrigger(editor, trigger);
}

export function stopLiveTrigger(noteId: string): void {
  const editor = getTourNoteEditor(noteId);
  try {
    if (editor !== null) stopTourTrigger(editor);
  } finally {
    restoreKeyboard(noteId);
    // Close the filter even if closing the menu throws, or the user's typing stays blocked until the tour ends.
    setTourTransactionFilter(noteId, false);
  }
}

const selecting = new WeakSet<TourEditor>();

type PmDoc = TourEditor["_tiptapEditor"]["state"]["doc"];

/** Paragraph equal to the sample sentence; if the user changed it, the first non-empty paragraph. */
function findDemoSentenceRange(doc: PmDoc): { from: number; to: number } | null {
  const sentence = i18n.t("tourGuide.sample.aiSentence");
  let exact: { from: number; to: number } | null = null;
  let firstFilled: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (exact !== null) return false;
    if (!node.isTextblock) return true;
    if (node.textContent.trim() === "") return false;
    const range = { from: pos + 1, to: pos + 1 + node.content.size };
    if (node.textContent === sentence) exact = range;
    else if (firstFilled === null && node.type.name === "paragraph") firstFilled = range;
    return false;
  });
  return exact ?? firstFilled;
}

/** Focus first: without it the format toolbar appears but the selection highlight is invisible and the editor doesn't scroll to the sentence. Only the selection changes, not the document: no undo entry, nothing in the Y doc. */
export function startLiveSelection(noteId: string): void {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return;
  setTourTransactionFilter(noteId, true);
  if (selecting.has(editor)) return;
  const view = editor._tiptapEditor.view;
  const range = findDemoSentenceRange(view.state.doc);
  if (range === null) return;
  selecting.add(editor);
  suppressKeyboard(noteId, editor);
  editor.focus();
  const { state } = view;
  // TextSelection has no importable source: take it from the current selection's class (`near` in a text paragraph always returns a TextSelection).
  const current = state.selection.constructor as unknown as { near(pos: unknown): { constructor: unknown } };
  const TextSel = current.near(state.doc.resolve(range.from)).constructor as unknown as {
    create(doc: PmDoc, anchor: number, head: number): typeof state.selection;
  };
  view.dispatch(state.tr.setSelection(TextSel.create(state.doc, range.from, range.to)).scrollIntoView());
}

export function stopLiveSelection(noteId: string): void {
  const editor = getTourNoteEditor(noteId);
  try {
    if (editor !== null && selecting.delete(editor) && !editor._tiptapEditor.isDestroyed) {
      const { state, view } = editor._tiptapEditor;
      if (!state.selection.empty) {
        const SelCtor = state.selection.constructor as unknown as { near(pos: unknown): typeof state.selection };
        view.dispatch(state.tr.setSelection(SelCtor.near(state.doc.resolve(state.selection.to))));
      }
    }
  } finally {
    restoreKeyboard(noteId);
    setTourTransactionFilter(noteId, false);
  }
}

export function liveSelectionTarget(): Element[] {
  const button = findFormattingToolbarButton(i18n.t("ai.toolbar.trigger"));
  return button === null ? [] : [button];
}

/** Elements already scrolled to for the fallback target: the target is re-queried every frame, so scroll only on first find and don't fight the user's own scrolling afterwards. */
const scrolledFallbacks = new WeakSet<Element>();

/** "Open" must mean opened by the tour itself with this trigger: a menu the user opened, or the previous step's, doesn't count. When not demoing or the menu closed for some reason (e.g. window blur) point at the finished artifact in the note, no empty arrow. Empty until the menu is drawn (the engine waits). */
export function liveTriggerTarget(noteId: string, trigger: TourTrigger, menuId: TourTargetId, fallbackId: TourTargetId): Element[] {
  const editor = getTourNoteEditor(noteId);
  if (editor !== null && active.has(editor) && isTriggerMenuShown(editor, trigger)) {
    const menu = findTourTarget(menuId);
    return menu === null ? [] : [menu];
  }
  const fallback = findInSampleEditor(noteId, fallbackId);
  if (fallback === null) return [];
  if (!scrolledFallbacks.has(fallback)) {
    scrolledFallbacks.add(fallback);
    if (typeof fallback.scrollIntoView === "function") fallback.scrollIntoView({ block: "nearest" });
  }
  return [fallback];
}

/** Only the sample note's editor: the page may hold other editor views (e.g. version preview). */
export function findInSampleEditor(noteId: string, id: TourTargetId): Element | null {
  return findTourTarget(id, getTourNoteEditor(noteId)?.domElement ?? document);
}

export interface LiveStopInput {
  next: () => void;
  back: () => void;
}

/**
 * Keyboard and mouse during a demo step are taken in window capture, earlier than the editor and BlockNote's menus.
 * →/Enter next, ← previous; Esc goes to the overlay (also capture; BlockNote closes menus on Esc itself, so it must win). Other keys never reach the editor, so arrows, characters and Tab can't move the menu.
 * Ctrl/Meta/Alt combos are stopped from the editor and menu (`stopPropagation`) but mostly not `preventDefault`ed, so browser shortcuts (reload, devtools, zoom) still work; function keys pass entirely. z/y (undo/redo: transactions coming back via Y pass the filter), v/x/a (paste, cut, select all) and Enter are also `preventDefault`ed.
 * Menu item clicks are blocked: a click closes the menu and then runs the item; the filter blocks the insert but the menu would be gone. Toolbar buttons too (the AI button opens the AI box); the overlay already blocks mouse clicks, this blocks clicks sent directly to elements (screen reader activation, `element.click()`).
 */
export function installLiveStopInput({ next, back }: LiveStopInput): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return;
    if (/^F\d{1,2}$/.test(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.stopPropagation();
      if (/^[zyvxa]$/i.test(e.key) || e.key === "Enter") e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.isComposing || e.keyCode === 229 || e.repeat) return;
    if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft") back();
  };
  const onClick = (e: MouseEvent) => {
    if (
      e.target instanceof Element &&
      e.target.closest('[data-kb-tour-target="wikilinkMenu"], [data-kb-tour-target="slashMenu"], [data-kb-formatting-toolbar-popover]') !== null
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
  };
}
