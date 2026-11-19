import { useLayoutEffect, useState } from "react";

/** Container-relative: the scroll container's visible size and the first text line's position. */
export interface OutlineBox {
  width: number;
  height: number;
  /**
   * Distance from the container top to the first block's content top, at scroll 0 (independent of current scroll); null
   * before any block exists. The headings outline aligns its top with it.
   */
  firstLineTop: number | null;
}

/** null until both elements are mounted; skips re-rendering when the values are unchanged. */
export function useOutlineBox(scrollEl: HTMLElement | null, columnEl: HTMLElement | null): OutlineBox | null {
  const [box, setBox] = useState<OutlineBox | null>(null);

  useLayoutEffect(() => {
    if (scrollEl === null || columnEl === null) {
      setBox(null);
      return;
    }
    const measure = () => {
      const scrollRect = scrollEl.getBoundingClientRect();
      const firstBlock = columnEl.querySelector(".bn-block-content");
      const next: OutlineBox = {
        width: scrollEl.clientWidth,
        height: scrollEl.clientHeight,
        firstLineTop: firstBlock === null ? null : Math.round(firstBlock.getBoundingClientRect().top - scrollRect.top + scrollEl.scrollTop),
      };
      setBox((prev) => (prev !== null && prev.width === next.width && prev.height === next.height && prev.firstLineTop === next.firstLineTop ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    observer.observe(columnEl);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [scrollEl, columnEl]);

  return box;
}
