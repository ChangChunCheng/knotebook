import type { RefObject } from "react";
import { useIsPhone } from "@/lib/layout-tiers";
import { LIST_STICKY_TOP_VAR, useStickyTopVar, useTierScrollAnchor } from "@/lib/page-scroll";

/** 清單列：整列是 `[data-node-kind]`（群組與資料夾的列包著底下的子列），位置量它自己那一行（第一個子元素）。 */
const LIST_ROWS = {
  itemSelector: "[data-node-kind]",
  idAttr: "data-node-id",
  measure: (item: HTMLElement) => item.firstElementChild ?? item,
};

/** 標題列釘住時的下緣：sticky 的 `top`（頂列高加上方 safe area）加上它自己的高度。 */
function stuckBottom(header: HTMLElement | null): number {
  if (header === null) return 0;
  const top = parseFloat(getComputedStyle(header).top);
  return (Number.isFinite(top) ? top : 0) + header.getBoundingClientRect().height;
}

/**
 * 手機清單（`NoteList`／`TrashPanel`）的文件捲動：
 * - 標題列釘住時的下緣寫進 `LIST_STICKY_TOP_VAR`，清單列的 `scroll-margin-top` 靠它讓開頂列與標題列；
 * - 跨 640 時保住閱讀位置（`useTierScrollAnchor`，以畫面頂端第一列為準）。
 */
export function usePhoneListScroll(listRef: RefObject<HTMLElement | null>, headerRef: RefObject<HTMLElement | null>): void {
  const phone = useIsPhone();
  useStickyTopVar(headerRef, phone, LIST_STICKY_TOP_VAR);
  useTierScrollAnchor({ containerRef: listRef, ...LIST_ROWS, phoneTop: () => stuckBottom(headerRef.current) });
}
