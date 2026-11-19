import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { createLongPress, type LongPress } from "@/lib/long-press";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generics; repo convention is any (avoids a circular import, same as spec.tsx)
type AnyEditor = BlockNoteEditor<any, any, any>;

/** Same delays as BlockNote's `LinkToolbarController` hover. */
export const HOVER_OPEN_MS = 250;
export const HOVER_CLOSE_MS = 250;

type Source = "hover" | "press";

/**
 * Hover and touch long-press open the toolbar; neither steals focus. A hover stays open while the pointer is on
 * the toolbar or focus is inside it. Click doesn't open it: it navigates (see `useWikilinkClick`). Keyboard
 * can't open it (known limitation). A close caused by hover-leave doesn't return focus to the editor.
 */
export function useToolbarTriggers(editor: AnyEditor, editable: boolean) {
  const [source, setSourceState] = useState<Source | null>(null);
  const sourceRef = useRef<Source | null>(null);
  const hoverClosedRef = useRef(false);
  // Restore focus on close only if the editor had focus at open or the user used the toolbar;
  // otherwise (phone long-press, tap outside) it would raise the virtual keyboard.
  const editorHadFocusRef = useRef(false);
  const interactedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSource = useCallback(
    (next: Source | null) => {
      if (next !== null && sourceRef.current === null) {
        hoverClosedRef.current = false;
        interactedRef.current = false;
        try {
          editorHadFocusRef.current = editor._tiptapEditor.view.hasFocus();
        } catch {
          editorHadFocusRef.current = false; // tiptap's view proxy throws when not yet mounted or already unmounted
        }
      }
      sourceRef.current = next;
      setSourceState(next);
    },
    [editor],
  );
  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);
  const scheduleHoverClose = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (sourceRef.current !== "hover" || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (sourceRef.current !== "hover" || contentRef.current?.contains(document.activeElement)) return;
      hoverClosedRef.current = true;
      sourceRef.current = null;
      setSourceState(null);
    }, HOVER_CLOSE_MS);
  };
  const cancelHoverClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const [press] = useState<LongPress>(() =>
    createLongPress(() => {
      clearTimers();
      setSource("press");
    }),
  );
  useEffect(
    () => () => {
      clearTimers();
      press.dispose();
    },
    [clearTimers, press],
  );

  const anchorHandlers = editable
    ? {
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          if (e.pointerType === "touch") return;
          cancelHoverClose();
          if (sourceRef.current !== null || openTimer.current !== null) return;
          openTimer.current = setTimeout(() => {
            openTimer.current = null;
            setSource("hover");
          }, HOVER_OPEN_MS);
        },
        onPointerLeave: (e: PointerEvent<HTMLElement>) => {
          if (e.pointerType !== "touch") scheduleHoverClose();
        },
        onPointerDown: (e: PointerEvent<HTMLElement>) => press.down(e),
        onPointerMove: (e: PointerEvent<HTMLElement>) => press.move(e),
        onPointerUp: () => press.end(),
        onPointerCancel: () => press.end(),
        onContextMenu: (e: MouseEvent<HTMLElement>) => {
          if (press.contextMenu()) e.preventDefault();
        },
        // The browser may re-fire mouse events after a long-press; stop them in capture so ProseMirror doesn't move the cursor and steal focus from the new toolbar.
        onMouseDownCapture: (e: MouseEvent<HTMLElement>) => {
          if (!press.suppressing()) return;
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};

  return {
    open: source !== null,
    contentRef,
    anchorHandlers,
    /** True: this click was re-fired after a long-press; the caller must swallow it instead of navigating. */
    consumeClick: (e: MouseEvent<HTMLElement>) => {
      if (!editable || !press.consumeClick()) {
        clearTimers();
        if (sourceRef.current === "hover") setSource(null);
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    onOpenChange: (open: boolean) => {
      clearTimers();
      if (!open) setSource(null);
    },
    contentHandlers: {
      onPointerDownCapture: () => {
        interactedRef.current = true;
      },
      onFocusCapture: () => {
        interactedRef.current = true;
      },
      onPointerEnter: cancelHoverClose,
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch") scheduleHoverClose();
      },
    },
    editorHadFocus: () => editorHadFocusRef.current,
    shouldRestoreFocus: () => !hoverClosedRef.current && (editorHadFocusRef.current || interactedRef.current),
  };
}
