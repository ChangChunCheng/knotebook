import { useLayoutEffect, useRef, useState } from "react";

/** 捲動容器的可視寬高，與內文欄右緣的位置；都以容器左緣為原點。 */
export interface OutlineBox {
  width: number;
  height: number;
  columnRight: number;
}

/**
 * 量測捲動容器與內文欄；視窗或任一元素改變尺寸時更新，欄的 class 換了（釘住、取消釘住）也重量，值沒變就不重繪。
 * 任一元素還沒掛上回 null。
 */
export function useOutlineBox(scrollEl: HTMLElement | null, columnEl: HTMLElement | null): OutlineBox | null {
  const [box, setBox] = useState<OutlineBox | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  /** 上次量的時候欄的 class。 */
  const measuredClass = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (scrollEl === null || columnEl === null) {
      setBox(null);
      return;
    }
    const measure = () => {
      measuredClass.current = columnEl.className;
      const next: OutlineBox = {
        width: scrollEl.clientWidth,
        height: scrollEl.clientHeight,
        columnRight: columnEl.getBoundingClientRect().right - scrollEl.getBoundingClientRect().left,
      };
      setBox((prev) =>
        prev !== null && prev.width === next.width && prev.height === next.height && prev.columnRight === next.columnRight ? prev : next,
      );
    };
    measureRef.current = measure;
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
      measureRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", measure);
      columnEl.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [scrollEl, columnEl]);

  // 欄的 class 由呼叫這支 hook 的元件渲染，換 class 的那次 commit 一定會跑到這裡。減少動態效果時沒有過場、也就沒有
  // transitionend，欄已經移到新位置：在畫面更新之前重量。class 沒變就不碰版面。
  useLayoutEffect(() => {
    if (columnEl === null || measureRef.current === null || columnEl.className === measuredClass.current) return;
    measureRef.current();
  });

  return box;
}
