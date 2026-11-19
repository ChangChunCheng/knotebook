import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";

const HEADING_SELF = ':scope > .bn-block > .bn-block-content[data-content-type="heading"]';
const HEADING_TEXT = ":scope > .bn-block > .bn-block-content > .bn-inline-content";

/** Walks up to the nearest `.bn-block-outer`: null hides the button, undefined (target is in no block, e.g. the # button itself) leaves it unchanged. */
function headingOuterOf(node: EventTarget | Node | null): HTMLElement | null | undefined {
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const outer = el?.closest<HTMLElement>(".bn-block-outer") ?? null;
  if (!outer) return undefined;
  if (outer.closest('[data-node-type="column"]')) return null;
  return outer.querySelector(HEADING_SELF) ? outer : null;
}

type Size = { width: number; height: number };

/**
 * "#" sits to the right of the heading text: on the left, BlockNote's side menu (z-index 20) overlaps the block's left edge and the button would be visible but unclickable.
 * Clamped to the column's right edge so long headings don't cause horizontal scroll (1px overflow seen on narrow public pages).
 */
function placeOf(outer: HTMLElement, container: HTMLElement, button: Size): { top: number; left: number } {
  const box = container.getBoundingClientRect();
  const inline = outer.querySelector<HTMLElement>(HEADING_TEXT) ?? outer;
  const text = inline.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(inline);
  const firstLine = range.getClientRects()[0] ?? text;
  return {
    top: firstLine.top - box.top + (firstLine.height - button.height) / 2,
    left: Math.min(text.right - box.left + 4, box.width - button.width),
  };
}

type Target = { outer: HTMLElement; id: string; top: number; left: number };

export function HeadingAnchorButtons({ container, linkBase }: { container: HTMLElement | null; linkBase?: () => string }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Size unknown before the first render (0); re-measured in a layout effect before paint, so no flash.
  const sizeRef = useRef<Size>({ width: 0, height: 0 });

  useEffect(() => {
    if (!container) return;
    const show = (found: HTMLElement | null | undefined) => {
      if (found === undefined) return;
      if (found === null) {
        setTarget(null);
        return;
      }
      const id = found.getAttribute("data-id");
      if (!id) return;
      setTarget({ outer: found, id, ...placeOf(found, container, sizeRef.current) });
    };
    const onPointerOver = (e: PointerEvent) => show(headingOuterOf(e.target));
    const onPointerLeave = () => setTarget(null);
    const onSelection = () => {
      const anchor = document.getSelection()?.anchorNode ?? null;
      if (anchor && container.contains(anchor)) show(headingOuterOf(anchor));
    };
    container.addEventListener("pointerover", onPointerOver);
    container.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      container.removeEventListener("pointerover", onPointerOver);
      container.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [container]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || !container) return;
    const { width, height } = button.getBoundingClientRect();
    if (width === sizeRef.current.width && height === sizeRef.current.height) return;
    sizeRef.current = { width, height };
    setTarget(cur => (cur ? { ...cur, ...placeOf(cur.outer, container, sizeRef.current) } : cur));
  }, [target, container]);

  // While shown, re-measure on layout changes (column width, content shifting, window resize) and hide when the block is deleted. The wrapper scrolls with the content, so scrolling needs no recompute.
  const outer = target?.outer ?? null;
  useEffect(() => {
    if (!container || !outer) return;
    const replace = () =>
      setTarget(cur => {
        if (!cur || cur.outer !== outer) return cur;
        if (!outer.isConnected) return null;
        const next = placeOf(outer, container, sizeRef.current);
        return next.top === cur.top && next.left === cur.left ? cur : { ...cur, ...next };
      });
    const observer = new ResizeObserver(replace);
    observer.observe(container);
    observer.observe(outer);
    window.addEventListener("resize", replace);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", replace);
    };
  }, [container, outer]);

  if (!target) return null;
  const base = linkBase ? linkBase() : absoluteUrl(window.location.pathname);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={t("note.blockLink.copyHeading")}
      title={t("note.blockLink.copyHeading")}
      className="absolute z-10 rounded px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ top: target.top, left: target.left }}
      onClick={() => void copyBlockLink(blockLinkUrl(base, target.id), t)}
    >
      #
    </button>
  );
}
