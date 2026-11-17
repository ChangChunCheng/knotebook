import { useLayoutEffect, useState } from "react";

/** 捲動容器的可視寬高，與第一行內文的位置；以容器為原點。 */
export interface OutlineBox {
  width: number;
  height: number;
  /**
   * 第一個區塊內容頂端離容器上緣的距離，以捲到最上面時的位置算（與目前捲動無關）；量不到（還沒有區塊）為 null。
   * 標題大綱的上緣對齊它。
   */
  firstLineTop: number | null;
}

/**
 * 量測捲動容器與第一行內文；視窗或任一元素改變尺寸時更新，值沒變就不重繪。
 * 任一元素還沒掛上回 null。
 */
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
