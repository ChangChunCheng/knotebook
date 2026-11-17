import { useLayoutEffect, useState } from "react";

/** 捲動容器的可視寬高，與內文欄右緣的位置；都以容器左緣為原點。 */
export interface OutlineBox {
  width: number;
  height: number;
  columnRight: number;
}

/** 量測捲動容器與內文欄；視窗或任一元素改變尺寸時更新，值沒變就不重繪。任一元素還沒掛上回 null。 */
export function useOutlineBox(scrollEl: HTMLElement | null, columnEl: HTMLElement | null): OutlineBox | null {
  const [box, setBox] = useState<OutlineBox | null>(null);

  useLayoutEffect(() => {
    if (scrollEl === null || columnEl === null) {
      setBox(null);
      return;
    }
    const measure = () => {
      const next: OutlineBox = {
        width: scrollEl.clientWidth,
        height: scrollEl.clientHeight,
        columnRight: columnEl.getBoundingClientRect().right - scrollEl.getBoundingClientRect().left,
      };
      setBox((prev) =>
        prev !== null && prev.width === next.width && prev.height === next.height && prev.columnRight === next.columnRight ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    observer.observe(columnEl);
    window.addEventListener("resize", measure);
    // 釘住時內文欄靠 left 位移、寬度不變，ResizeObserver 不會通知；過場結束時再量一次。
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target === columnEl) measure();
    };
    columnEl.addEventListener("transitionend", onTransitionEnd);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      columnEl.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [scrollEl, columnEl]);

  return box;
}
