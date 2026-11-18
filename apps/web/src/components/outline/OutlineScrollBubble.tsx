import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useKeyboardInset } from "@/lib/visual-viewport";
import { useColorPanelHeight } from "@/components/editor/mobile/toolbar-footprint";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { OUTLINE_BUBBLE_HEIGHT_PX, OUTLINE_TRACK_GAP_PX, readScrollMetrics, scrollFraction, trackBottomReserve } from "./bubble-track";
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
  /**
   * Pixels to keep clear below the track while the edit toolbar is not up: the phone's floating buttons, or the
   * version history bubble.
   */
  bottomReserve?: number;
  /** `page` only. Above 0 the edit toolbar is up and the track stops this far above the keyboard or colour panel. */
  editToolbarHeight?: number;
  /** While true the chip does not count down (e.g. while the sheet it opened is up); when it turns false the countdown starts again. */
  hold?: boolean;
  /**
   * Tapped or activated. Gets the chip as the place to return focus to only when it had focus (keyboard or screen reader);
   * a touch tap leaves focus where it was (the chip does not take it), so then `null`.
   */
  onOpen: (returnFocusTo: HTMLElement | null) => void;
}

/**
 * Phone-only chip showing the current section while the page scrolls. It appears on scroll, leaves the tree
 * {@link OUTLINE_BUBBLE_HIDE_MS} after the last scroll, and rides a track along the right edge: its position on the
 * track is the scroll position.
 */
export function OutlineScrollBubble({
  headings,
  activeId,
  scrollTarget,
  placement,
  inputRoot = null,
  bottomReserve = 0,
  editToolbarHeight = 0,
  hold = false,
  onOpen,
}: OutlineScrollBubbleProps) {
  const { t } = useTranslation();
  const keyboardInset = useKeyboardInset();
  const colorPanelHeight = useColorPanelHeight();
  const [fraction, setFraction] = useState(0);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const held = useRef(hold);
  held.current = hold;
  const arm = useRef<() => void>(() => {});
  /** `performance.now()` of the last typing or focus inside `inputRoot`; -Infinity before any. */
  const lastInput = useRef(Number.NEGATIVE_INFINITY);
  // The anchored bubble sits over the card, whose scroll container may have a classic scrollbar: keep clear of it.
  const [gutter, setGutter] = useState(0);
  // The anchored track is as tall as the scroll container (minus gaps and reserve).
  const [clientHeight, setClientHeight] = useState(0);
  // How far the scroll container's bottom edge is above the bottom of the window; the keyboard only matters where it overlaps.
  const [containerBottomGap, setContainerBottomGap] = useState(0);
  useEffect(() => {
    if (placement !== "anchor" || scrollTarget === null || scrollTarget === window) return;
    const el = scrollTarget as HTMLElement;
    const measure = () => {
      setGutter(Math.max(0, el.offsetWidth - el.clientWidth));
      setClientHeight(el.clientHeight);
      setContainerBottomGap(Math.max(0, window.innerHeight - el.getBoundingClientRect().bottom));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [placement, scrollTarget, keyboardInset]);

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
      if (focused.current || held.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setVisible(false);
      }, OUTLINE_BUBBLE_HIDE_MS);
    };
    arm.current = schedule;
    const onScroll = () => {
      if (performance.now() - lastInput.current < OUTLINE_BUBBLE_INPUT_QUIET_MS) return;
      setFraction(scrollFraction(readScrollMetrics(scrollTarget)));
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

  // Holding stops the countdown; letting go starts it again (unless the chip has focus by then).
  useEffect(() => {
    arm.current();
  }, [hold]);

  // With the keyboard, the toolbar and the colour panel up on a short screen, the track can be shorter than the chip: the chip
  // is then hidden rather than hanging over the toolbar. Measured when the track mounts (before it is painted) and on resize.
  const [trackTooShort, setTrackTooShort] = useState(false);
  const trackObserver = useRef<ResizeObserver | null>(null);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    trackObserver.current?.disconnect();
    trackObserver.current = null;
    if (!el) return;
    // No client rects: not laid out (yet), nothing to compare.
    const measure = () => setTrackTooShort(el.getClientRects().length > 0 && el.getBoundingClientRect().height < OUTLINE_BUBBLE_HEIGHT_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    trackObserver.current = new ResizeObserver(measure);
    trackObserver.current.observe(el);
  }, []);

  const reserve = trackBottomReserve({ placement, keyboardInset, colorPanelHeight, editToolbarHeight, bottomReserve, containerBottomGap });
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
      ref={trackRef}
      data-testid="outline-bubble-track"
      className={cn(
        "pointer-events-none z-30 w-[60vw]",
        placement === "page"
          ? "fixed right-[max(0.5rem,env(safe-area-inset-right))] top-[calc(var(--kb-sticky-top,0px)+0.5rem)] bottom-[calc(var(--outline-track-reserve,0px)+0.5rem+env(safe-area-inset-bottom,0px))]"
          : "absolute top-2 right-[calc(0.5rem+var(--outline-track-gutter,0px))]",
      )}
      style={
        placement === "page"
          ? ({ "--outline-track-reserve": `${reserve}px` } as CSSProperties)
          : ({
              "--outline-track-gutter": `${gutter}px`,
              height: `${Math.max(0, clientHeight - 2 * OUTLINE_TRACK_GAP_PX - reserve)}px`,
            } as CSSProperties)
      }
    >
      <div
        // `pointer-events-auto`: the track lets the pointer through, the chip takes taps. No transition: eased over each
        // scroll event, the chip trails a fast scroll by several dozen pixels and doubles back when the scroll slows.
        className={cn("pointer-events-auto absolute right-0 flex h-9 max-w-full", trackTooShort && "invisible")}
        style={
          {
            "--outline-bubble-fraction": fraction,
            top: `max(0px, calc((100% - ${OUTLINE_BUBBLE_HEIGHT_PX}px) * var(--outline-bubble-fraction)))`,
          } as CSSProperties
        }
      >
        <button
          type="button"
          aria-label={t("note.outline.openAt", { position })}
          onClick={(e) => onOpen(document.activeElement === e.currentTarget ? e.currentTarget : null)}
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
    </div>
  );
}
