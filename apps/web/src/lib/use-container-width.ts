import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Content-box width for both the initial value and the ResizeObserver: mixing a border-box initial value with
 * `contentRect` would differ by the padding and flip near the threshold (`SPLIT_MIN_WIDTH`).
 * jsdom's ResizeObserver is a no-op (`test/setup.ts`), so tests inject it with vi.mock.
 */
function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}

export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(contentWidth(el));
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
