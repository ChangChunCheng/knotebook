import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";

/**
 * On phones (< 640) the document itself scrolls (the browser toolbar can collapse and content
 * extends behind the bottom toolbar); from 640 up the framed container scrolls. Code that targets
 * the scroll container (scroll to top, visible height, scroll to a collaborator's cursor) checks
 * `scrollsPage(root)` first and uses the window when true, since that container doesn't scroll on
 * phones. Public pages are outside the frame and scroll their own container even on phones.
 */
export const PHONE_PAGE_SCROLL_ATTR = "data-phone-page-scroll";

/**
 * Flags on `<html>` that index.css phone styles key off. Not `html:has([…])`: a `:has()` anchored
 * on `<html>` may make any DOM insertion or removal recompute styles for the whole document, slowing
 * menus, dialogs and image zoom on long notes.
 */
export const ROOT_FLAGS = {
  pageScroll: "data-has-phone-page-scroll",
  listShown: "data-has-phone-list-shown",
  editToolbar: "data-has-mobile-edit-toolbar",
} as const;

// Ref-counted: during a page change the old and new page briefly both hold a flag; remove it only when the last one leaves.
const rootFlagCounts = new Map<string, number>();

export function useRootFlag(attr: string, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const count = (rootFlagCounts.get(attr) ?? 0) + 1;
    rootFlagCounts.set(attr, count);
    if (count === 1) root.setAttribute(attr, "");
    return () => {
      const left = (rootFlagCounts.get(attr) ?? 1) - 1;
      if (left > 0) {
        rootFlagCounts.set(attr, left);
        return;
      }
      rootFlagCounts.delete(attr);
      root.removeAttribute(attr);
    };
  }, [attr, active]);
}

/** px height (incl. notch safe area) of the pinned phone note header; index.css uses it as block `scroll-margin-top`, so a block scrolled to is not hidden under the header. */
export const STICKY_TOP_VAR = "--kb-sticky-top";

/** px from the viewport top to the bottom of the pinned part of the phone list; index.css uses it as row `scroll-margin-top`, so a row focused by keyboard or screen reader is not hidden under the top bar. */
export const LIST_STICKY_TOP_VAR = "--kb-list-sticky-top";

export function scrollsPage(root: Element | null | undefined): boolean {
  return root !== null && root !== undefined && isPhone() && root.closest(`[${PHONE_PAGE_SCROLL_ATTR}]`) !== null;
}

function readTopVar(name: string): number {
  if (typeof document === "undefined") return 0;
  const value = parseFloat(document.documentElement.style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

export function stickyTopInset(): number {
  return readTopVar(STICKY_TOP_VAR);
}

export function listStickyTopInset(): number {
  return readTopVar(LIST_STICKY_TOP_VAR);
}

const stickyListeners = new Set<() => void>();

function subscribeSticky(listener: () => void): () => void {
  stickyListeners.add(listener);
  return () => stickyListeners.delete(listener);
}

export function useStickyTopInset(): number {
  return useSyncExternalStore(subscribeSticky, stickyTopInset, () => 0);
}

export function scrollToTopOf(root: HTMLElement): void {
  if (scrollsPage(root)) {
    window.scrollTo({ top: 0 });
    return;
  }
  if (typeof root.scrollTo === "function") root.scrollTo({ top: 0 });
  else root.scrollTop = 0;
}

export function visibleHeightOf(root: HTMLElement): number {
  return scrollsPage(root) ? Math.max(0, window.innerHeight - stickyTopInset()) : root.clientHeight;
}

function inPageScrollFrame(el: Element): boolean {
  return el.closest(`[${PHONE_PAGE_SCROLL_ATTR}]`) !== null;
}

/**
 * Removes only the value this instance wrote (another instance may have rewritten it). Not
 * written outside the document-scroll frame (e.g. a list in a drawer); measures 0 when hidden.
 */
export function useStickyTopVar(ref: RefObject<HTMLElement | null>, enabled: boolean, name: string = STICKY_TOP_VAR): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || !inPageScrollFrame(element)) return;
    const root = document.documentElement;
    const notify = () => stickyListeners.forEach((listener) => listener());
    let written: string | null = null;
    const write = () => {
      const rect = element.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(element).top);
      const value = `${Math.round((rect.height > 0 && Number.isFinite(top) ? top : 0) + rect.height)}px`;
      written = value;
      if (root.style.getPropertyValue(name) === value) return;
      root.style.setProperty(name, value);
      notify();
    };
    write();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(write) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (written === null || root.style.getPropertyValue(name) !== written) return;
      root.style.removeProperty(name);
      notify();
    };
  }, [ref, enabled, name]);
}

export interface ScrollAnchor {
  id: string;
  offset: number;
  height: number;
}

export interface AnchorItems {
  itemSelector: string;
  idAttr: string;
  /** For a block, measure its own line, excluding nested child blocks. */
  measure?: (item: HTMLElement) => Element;
}

function visibleBox(el: Element): DOMRect | null {
  const rect = el.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/**
 * Linear scan, not binary search: in side-by-side columns later columns' blocks come later in the
 * document but their positions restart at the top, so position does not increase with order.
 * Cost is bounded by the caller: `useTierScrollAnchor` runs it only on devices that may cross 640,
 * at most once per frame.
 */
export function captureScrollAnchor(container: Element, items: AnchorItems, top: number): ScrollAnchor | null {
  for (const item of container.querySelectorAll<HTMLElement>(items.itemSelector)) {
    const rect = visibleBox(items.measure?.(item) ?? item);
    if (rect === null || rect.bottom <= top) continue;
    const id = item.getAttribute(items.idAttr);
    if (id !== null && id !== "") return { id, offset: rect.top - top, height: rect.height };
  }
  return null;
}

/** When the item's top has scrolled past the line, the width differs after the tier change, so the scrolled-past part is converted proportionally to height. */
export function restoreScrollAnchor(container: Element, items: AnchorItems, anchor: ScrollAnchor, top: number, scrollBy: (dy: number) => void): boolean {
  const item = Array.from(container.querySelectorAll<HTMLElement>(items.itemSelector)).find((el) => el.getAttribute(items.idAttr) === anchor.id);
  if (item === undefined) return false;
  const rect = visibleBox(items.measure?.(item) ?? item);
  if (rect === null) return false;
  const offset = anchor.offset < 0 && anchor.height > 0 ? (anchor.offset * rect.height) / anchor.height : anchor.offset;
  const dy = rect.top - top - offset;
  if (Math.abs(dy) >= 1) scrollBy(dy);
  return true;
}

/** A screen whose short side is under 640 is a phone (wider when landscape). Desktop windows dragged across 640 do not preserve position (docs/known-limitations.md). */
export function phoneSizedScreen(): boolean {
  return typeof screen !== "undefined" && Math.min(screen.width, screen.height) < 640;
}

/** Also devices whose primary pointer is a finger: tablet split-screen/rotation and foldables can cross 640 with a short side above it. Mouse-only desktops skip the cost. */
export function mayCrossTiersByDefault(): boolean {
  return phoneSizedScreen() || (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
}

export interface TierScrollAnchorOptions extends AnchorItems {
  containerRef: RefObject<HTMLElement | null>;
  phoneTop: () => number;
  mayCrossTiers?: () => boolean;
}

/**
 * Phone scrolls the document and 640+ scrolls the container; both start at 0 on a switch and lay
 * out differently, so remember "first visible item + distance from the top" and scroll that item
 * back after the switch.
 * - Only its own scroll counts (document on phone, container at 640+; table/menu scrolls are
 *   ignored), at most one measurement per frame; the last one before the switch is restored.
 * - From 640 up, recorded only on devices that may return to phone width.
 * - Skipped while the media query has flipped but React has not switched tiers (the document is
 *   clamped to 0): when `isPhone()` disagrees with the layout's tier.
 * - Nothing is recorded or restored while the container is invisible (the record is kept for a
 *   later switch while visible) or outside the document-scroll frame.
 */
export function useTierScrollAnchor(options: TierScrollAnchorOptions): void {
  const phone = useIsPhone();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tierRef = useRef(phone);
  const savedRef = useRef<{ container: HTMLElement; anchor: ScrollAnchor } | null>(null);

  useEffect(() => {
    let frame = 0;
    const capture = () => {
      frame = 0;
      const { containerRef, phoneTop, mayCrossTiers: _mayCrossTiers, ...items } = optionsRef.current;
      const container = containerRef.current;
      if (container === null || !inPageScrollFrame(container) || isPhone() !== tierRef.current || container.getClientRects().length === 0) return;
      const top = tierRef.current ? phoneTop() : container.getBoundingClientRect().top;
      const anchor = captureScrollAnchor(container, items, top);
      savedRef.current = anchor === null ? null : { container, anchor };
    };
    const onScroll = (event: Event) => {
      const container = optionsRef.current.containerRef.current;
      const ours = tierRef.current ? event.target === document : container !== null && event.target === container;
      if (!ours || frame !== 0) return;
      if (!tierRef.current && !(optionsRef.current.mayCrossTiers ?? mayCrossTiersByDefault)()) return;
      frame = requestAnimationFrame(capture);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    if (tierRef.current === phone) return;
    tierRef.current = phone;
    const saved = savedRef.current;
    const { containerRef, phoneTop, mayCrossTiers, ...items } = optionsRef.current;
    // Discard the phone-width record once restored on a device that does not remember position at 640+, so narrowing later does not jump.
    if (!phone && !(mayCrossTiers ?? mayCrossTiersByDefault)()) savedRef.current = null;
    const container = containerRef.current;
    if (saved === null || container === null || saved.container !== container || !inPageScrollFrame(container) || container.getClientRects().length === 0) return;
    const restore = () => {
      if (phone) restoreScrollAnchor(container, items, saved.anchor, phoneTop(), (dy) => window.scrollTo(0, window.scrollY + dy));
      else restoreScrollAnchor(container, items, saved.anchor, container.getBoundingClientRect().top, (dy) => (container.scrollTop += dy));
    };
    restore();
    // Effects may still change layout after the tier-change render: align once more next frame, using
    // the pre-change record (scroll records in that window may come from a transitional layout).
    let frame = requestAnimationFrame(() => {
      frame = 0;
      if (isPhone() === phone && container.isConnected) restore();
    });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [phone]);
}
