import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import type { OutlineHeading } from "./headings";

/** How long after the last scroll the position bubble stays. */
export const OUTLINE_BUBBLE_HIDE_MS = 1500;

/** Scrolls this soon after typing in the editor are the caret being kept in view, not the reader scrolling. */
export const OUTLINE_BUBBLE_INPUT_QUIET_MS = 300;

/**
 * Editor events after which the page may scroll on its own: typing and pasting (the caret is kept in view), and focusing
 * (the keyboard opens and the caret is brought into view).
 */
const INPUT_EVENTS = ["keydown", "beforeinput", "input", "paste", "focusin"] as const;

export interface OutlineScrollBubbleProps {
  headings: readonly OutlineHeading[];
  activeId: string | null;
  /** What scrolls: the window on a phone page, or the scroll container. */
  scrollTarget: HTMLElement | Window | null;
  /** `page`: fixed under the sticky page header. `anchor`: absolute inside a positioned anchor outside the scroller. */
  placement: "page" | "anchor";
  /**
   * The editable area, when there is one. Scrolls within {@link OUTLINE_BUBBLE_INPUT_QUIET_MS} of typing or focusing
   * inside it do not show the bubble: the editor scrolls to keep the caret in view, and the bubble would pop up on every line.
   * While focus is inside it, a resize of the visual viewport (the keyboard opening or closing, which can take longer than that
   * and scrolls as it goes) counts as input too.
   */
  inputRoot?: HTMLElement | null;
  /** Tapped; gets the chip itself, somewhere to return focus while it is still in the page. */
  onOpen: (anchor: HTMLElement) => void;
}

/**
 * Phone-only chip showing the current section while the page scrolls. It appears on scroll, leaves the tree
 * {@link OUTLINE_BUBBLE_HIDE_MS} after the last scroll, and is tap-only (no drag).
 */
export function OutlineScrollBubble({ headings, activeId, scrollTarget, placement, inputRoot = null, onOpen }: OutlineScrollBubbleProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const arm = useRef<() => void>(() => {});
  /** `performance.now()` of the last typing or focus inside `inputRoot`; -Infinity before any. */
  const lastInput = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (!inputRoot) return;
    const mark = () => {
      lastInput.current = performance.now();
    };
    for (const type of INPUT_EVENTS) inputRoot.addEventListener(type, mark, { capture: true, passive: true });
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    const onViewportResize = () => {
      if (inputRoot.contains(document.activeElement)) mark();
    };
    viewport?.addEventListener("resize", onViewportResize);
    return () => {
      for (const type of INPUT_EVENTS) inputRoot.removeEventListener(type, mark, { capture: true });
      viewport?.removeEventListener("resize", onViewportResize);
    };
  }, [inputRoot]);

  useEffect(() => {
    if (!scrollTarget) return;
    // While the chip has focus it stays mounted, so keyboard and screen-reader users keep a reachable button.
    const schedule = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (focused.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setVisible(false);
      }, OUTLINE_BUBBLE_HIDE_MS);
    };
    arm.current = schedule;
    const onScroll = () => {
      if (performance.now() - lastInput.current < OUTLINE_BUBBLE_INPUT_QUIET_MS) return;
      setVisible(true);
      schedule();
    };
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [scrollTarget]);

  if (!visible || headings.length === 0) return null;
  const found = activeId === null ? -1 : headings.findIndex((h) => h.id === activeId);
  const index = found === -1 ? 0 : found;
  const text = headings[index]!.text;
  const position = t("note.outline.position", {
    title: text === "" ? t("note.outline.untitled") : text,
    index: index + 1,
    total: headings.length,
  });

  return (
    <div
      className={cn(
        // `pointer-events-auto`: the `anchor` placement sits in a layer that lets the pointer through.
        "pointer-events-auto z-30 flex h-9 max-w-[60vw] animate-in fade-in-0 duration-150",
        placement === "page"
          ? "fixed right-[max(0.5rem,env(safe-area-inset-right))] top-[calc(var(--kb-sticky-top,0px)+0.5rem)]"
          : "absolute right-2 top-2",
      )}
    >
      <button
        type="button"
        aria-label={t("note.outline.openAt", { position })}
        onClick={(e) => onOpen(e.currentTarget)}
        // Tapping must not blur the editor: the mobile toolbar and keyboard state stay as they are.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => {
          focused.current = true;
          arm.current();
        }}
        onBlur={() => {
          focused.current = false;
          arm.current();
        }}
        className={cn(
          // The visible chip is 36px high; the pseudo-element stretches the tap area to 44px.
          "relative flex h-9 min-w-0 max-w-full items-center rounded-full px-3 text-xs text-foreground",
          "after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
          FROSTED_SURFACE,
        )}
      >
        <span className="truncate">{position}</span>
      </button>
    </div>
  );
}
