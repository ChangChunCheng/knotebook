import type { RefObject } from "react";
import { useIsPhone } from "@/lib/layout-tiers";
import { LIST_STICKY_TOP_VAR, useStickyTopVar, useTierScrollAnchor } from "@/lib/page-scroll";

/** A list row is a whole `[data-node-kind]` (group and folder rows wrap their children); its position is measured on its own line, the first child. */
const LIST_ROWS = {
  itemSelector: "[data-node-kind]",
  idAttr: "data-node-id",
  measure: (item: HTMLElement) => item.firstElementChild ?? item,
};

function stuckBottom(header: HTMLElement | null): number {
  if (header === null) return 0;
  const top = parseFloat(getComputedStyle(header).top);
  return (Number.isFinite(top) ? top : 0) + header.getBoundingClientRect().height;
}

export function usePhoneListScroll(listRef: RefObject<HTMLElement | null>, headerRef: RefObject<HTMLElement | null>): void {
  const phone = useIsPhone();
  useStickyTopVar(headerRef, phone, LIST_STICKY_TOP_VAR);
  useTierScrollAnchor({ containerRef: listRef, ...LIST_ROWS, phoneTop: () => stuckBottom(headerRef.current) });
}
