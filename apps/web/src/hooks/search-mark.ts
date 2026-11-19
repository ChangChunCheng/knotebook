import { isOverlayOpen } from "@/lib/versions-context";

// Module-level bus: the mark lives in the editor's scroller, but search is closed from the sidebar, which has
// two instances and shares no parent or context with it.
const listeners = new Set<() => void>();

/** Same selector as OPEN_TOAST in SelectHeader.tsx. */
const OPEN_TOAST = 'li[data-swipe-direction][data-state="open"]';

// Yields to others' Esc: skipped while composing, with an overlay or toast open (Radix Toast doesn't preventDefault),
// or when already defaultPrevented after all listeners ran (setTimeout 0). Exception: BlockNote's OverrideEscape
// blurs the editor and then preventDefaults, so an Esc that left the editor still clears.
// The toast check runs at keydown (capture) since the same Esc closes the toast. The AI box and mermaid stop
// propagation, and the slash menu's Esc keeps focus in the editor, so neither clears.
export function watchSearchEscape(onEscape: () => void): () => void {
  let toastOpenAt: Event | null = null;
  const capture = (event: KeyboardEvent) => {
    toastOpenAt = event.key === "Escape" && document.querySelector(OPEN_TOAST) !== null ? event : null;
  };
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || isOverlayOpen()) return;
    if (toastOpenAt === event) return;
    setTimeout(() => {
      if (!event.defaultPrevented || blurredOutOfEditor(event)) onEscape();
    }, 0);
  };
  window.addEventListener("keydown", capture, { capture: true });
  window.addEventListener("keydown", handler);
  return () => {
    window.removeEventListener("keydown", capture, { capture: true });
    window.removeEventListener("keydown", handler);
  };
}

function blurredOutOfEditor(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(".ProseMirror") === null) return false;
  return document.activeElement?.closest(".ProseMirror") == null;
}

export function onSearchMarkClear(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function clearSearchMark(): void {
  for (const fn of Array.from(listeners)) fn();
}
