import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineHeading } from "./headings";

/** A heading counts as scrolled past when its top is within this many px below the visible top edge. */
export const OUTLINE_ACTIVE_SLACK_PX = 8;

/**
 * The last heading whose top has reached the threshold; before any has, the first one.
 * `top === null` (collapsed inside a toggle, not laid out) is skipped, so the current position
 * falls on the toggle heading that contains it.
 */
export function pickActiveHeading(
  entries: readonly { id: string; top: number | null }[],
  threshold: number,
): string | null {
  if (entries.length === 0) return null;
  let active: string | null = null;
  for (const e of entries) {
    if (e.top !== null && e.top <= threshold) active = e.id;
  }
  return active ?? entries[0].id;
}

/** The block wrapper of a heading inside the editor, at any depth. Ids are block ids, safe in a selector. */
export function headingElement(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`);
}

/** Viewport top of an element, or null when it is missing or not laid out (e.g. `display: none`). */
export function measureHeadingTop(el: HTMLElement | null): number | null {
  if (!el || el.getClientRects().length === 0) return null;
  return el.getBoundingClientRect().top;
}

export interface UseActiveHeadingOptions {
  headings: readonly OutlineHeading[];
  root: HTMLElement | null;
  scrollTarget: HTMLElement | Window | null;
  /** Viewport y of the visible top edge of the scrolling area. */
  topEdge: () => number;
  enabled: boolean;
}

export interface ActiveHeadingApi {
  activeId: string | null;
  /**
   * Pins `id` as the current heading after a jump, even when it cannot reach the top (the last headings
   * of a note). The pin holds until the reader scrolls by hand (wheel, touch, scroll keys, a press in the scrolling area); the jump's own
   * programmatic scroll does not clear it.
   */
  markJumped: (id: string) => void;
  /**
   * Clears the jump pin for a hand scroll that does not reach the scrolling area as an event of its own
   * (a wheel over the outline, forwarded to the note). The scroll it causes re-measures.
   */
  releaseJump: () => void;
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/**
 * Id of the heading the reader is currently in; measured at most once per frame while scrolling,
 * and again when the content's size changes without a scroll (a toggle collapses, edits move headings).
 */
export function useActiveHeading(opts: UseActiveHeadingOptions): ActiveHeadingApi {
  const { headings, root, scrollTarget, enabled } = opts;
  const [active, setActive] = useState<string | null>(null);
  const topEdgeRef = useRef(opts.topEdge);
  topEdgeRef.current = opts.topEdge;
  const pinnedRef = useRef<string | null>(null);

  const markJumped = useCallback((id: string) => {
    pinnedRef.current = id;
    setActive(id);
  }, []);
  const releaseJump = useCallback(() => {
    pinnedRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !root || !scrollTarget) return;
    if (pinnedRef.current !== null && !headings.some((h) => h.id === pinnedRef.current)) pinnedRef.current = null;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (pinnedRef.current !== null) return;
      const entries = headings.map((h) => ({ id: h.id, top: measureHeadingTop(headingElement(root, h.id)) }));
      const next = pickActiveHeading(entries, topEdgeRef.current() + OUTLINE_ACTIVE_SLACK_PX);
      setActive((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const release = () => {
      pinnedRef.current = null;
      schedule();
    };
    const onKey = (e: KeyboardEvent) => {
      // Keys another control already handled (arrows inside the outline list) are not scrolling.
      if (e.defaultPrevented) return;
      if (SCROLL_KEYS.has(e.key)) release();
    };
    scrollTarget.addEventListener("scroll", schedule, { passive: true });
    scrollTarget.addEventListener("wheel", release, { passive: true });
    scrollTarget.addEventListener("touchmove", release, { passive: true });
    // A press inside the scrolling area (scrollbar drag, an in-note link) can scroll without a wheel or key.
    scrollTarget.addEventListener("pointerdown", release, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("keydown", onKey);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(root);
      const content = root.querySelector(".bn-editor") ?? root.firstElementChild;
      if (content) observer.observe(content);
    }
    schedule();
    return () => {
      scrollTarget.removeEventListener("scroll", schedule);
      scrollTarget.removeEventListener("wheel", release);
      scrollTarget.removeEventListener("touchmove", release);
      scrollTarget.removeEventListener("pointerdown", release);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("keydown", onKey);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [headings, root, scrollTarget, enabled]);

  return { activeId: enabled ? active : null, markJumped, releaseJump };
}
