import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * #430: Ctrl/Cmd+Z, Shift+Z and Ctrl+Y still act on this note when focus isn't in the editor (after a drag-drop, a blank-space click, the column divider focused), then focus returns to the editor.
 * When yielding it never calls `preventDefault`: event already handled, IME composing, target / focus in an element with its own text undo (including the editor itself: its keymap doesn't
 * `preventDefault` when there is nothing to undo, and the bubbled event must not undo a second time), or an overlay is open.
 */

export type UndoAction = "undo" | "redo";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// When `key` is a Latin letter or ASCII symbol it decides (Dvorak types `;` at the Z position, BÉPO `à`); the physical key is consulted only for other scripts.
function letterOf(event: KeyboardEvent): string | null {
  const key = event.key;
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if ([...key].length !== 1 || /[\x21-\x7e]|\p{Script=Latin}/u.test(key)) return null;
  if (event.code === "KeyZ") return "z";
  if (event.code === "KeyY") return "y";
  return null;
}

export function undoKeyOf(event: KeyboardEvent): UndoAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const letter = letterOf(event);
  if (letter === "z") return event.shiftKey ? "redo" : "undo";
  if (letter === "y" && !event.shiftKey) return "redo";
  return null;
}

// Cmd+Y isn't taken on Mac: it is the browser's "History", and shouldn't be intercepted when no text input is focused.
export function undoActionOf(event: KeyboardEvent, mac: boolean = IS_MAC): UndoAction | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const action = undoKeyOf(event);
  if (mac && action === "redo" && !event.shiftKey) return null;
  return action;
}

const TEXT_ENTRY = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="hidden"])',
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");
const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-kb-ai-box], .kb-color-panel';

export function pageUndoYields(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  for (const el of [event.target, document.activeElement]) {
    if (el instanceof Element && el.closest(TEXT_ENTRY)) return true;
  }
  return document.querySelector(OPEN_LAYER) !== null;
}

export function attachPageUndoShortcut(editor: AnyEditor, isEnabled: () => boolean): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = undoActionOf(event);
    if (!action || !isEnabled() || !editor.isEditable || pageUndoYields(event)) return;
    if (!editor.prosemirrorView) return;
    event.preventDefault();
    const done = action === "undo" ? editor.undo() : editor.redo();
    if (done) editor.focus();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

export function usePageUndoShortcut(editor: AnyEditor, enabled: boolean): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => attachPageUndoShortcut(editor, () => enabledRef.current), [editor]);
}
