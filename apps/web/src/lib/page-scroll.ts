import { useEffect, type RefObject } from "react";
import { isPhone } from "@/lib/layout-tiers";

/**
 * 手機（< 640）上的捲動：`AppShell` 的外框不鎖高度，清單與筆記都是**文件**本身在捲（瀏覽器的工具列才會隨捲動收起，
 * 內容也才能延伸到半透明的底部工具列後面）。640 起照舊：外框鎖在視窗高、各區自己的 `overflow-y-auto` 容器在捲。
 *
 * 外框帶 `PHONE_PAGE_SCROLL_ATTR`。原本對「捲動容器」下指令的程式（捲回頂端、算可視高度、捲到協作者的游標）先問
 * `scrollsPage(root)`：成立時改對視窗做，因為那個容器在手機上不會捲。公開頁不在外框裡，手機上仍是自己的容器在捲。
 */
export const PHONE_PAGE_SCROLL_ATTR = "data-phone-page-scroll";

/**
 * `<html>` 上的 CSS 變數：手機上釘在頁面頂端的頁首有多高（px，含瀏海的 safe area）。`index.css` 拿它當筆記區塊的
 * `scroll-margin-top`，捲到段落時才不會把區塊捲到頁首底下。
 */
export const STICKY_TOP_VAR = "--kb-sticky-top";

/** `root` 在手機上是不是讓文件代為捲動（在帶 `PHONE_PAGE_SCROLL_ATTR` 的外框裡、而且是手機寬度）。 */
export function scrollsPage(root: Element | null | undefined): boolean {
  return root !== null && root !== undefined && isPhone() && root.closest(`[${PHONE_PAGE_SCROLL_ATTR}]`) !== null;
}

/** 頁面頂端釘住的頁首高度（px）；沒有設定時 0。 */
export function stickyTopInset(): number {
  if (typeof document === "undefined") return 0;
  const value = parseFloat(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR));
  return Number.isFinite(value) ? value : 0;
}

/** 捲回頂端：手機上捲文件，其他情形捲 `root` 自己。 */
export function scrollToTopOf(root: HTMLElement): void {
  if (scrollsPage(root)) {
    window.scrollTo({ top: 0 });
    return;
  }
  if (typeof root.scrollTo === "function") root.scrollTo({ top: 0 });
  else root.scrollTop = 0;
}

/** `root` 的內容實際能被看到的高度：手機上是視窗扣掉頂端的頁首，其他情形是 `root` 自己的可視高度。 */
export function visibleHeightOf(root: HTMLElement): number {
  return scrollsPage(root) ? Math.max(0, window.innerHeight - stickyTopInset()) : root.clientHeight;
}

/**
 * 量 `ref` 那個頁首的高度寫進 `<html>` 的 `STICKY_TOP_VAR`（直接寫 DOM，不重繪）。`enabled` 為 false 或卸載時移除。
 * 頁首被藏起來（`display: none`）時量到 0，變數跟著是 0。
 */
export function useStickyTopVar(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) return;
    const root = document.documentElement;
    // 量外框（含上方 safe area 的內距），不是內容框。
    const write = () => root.style.setProperty(STICKY_TOP_VAR, `${Math.round(element.getBoundingClientRect().height)}px`);
    write();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(write) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(STICKY_TOP_VAR);
    };
  }, [ref, enabled]);
}
