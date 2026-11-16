import { useEffect, type RefObject } from "react";

/** 還能往右捲的表格捲動層帶這個屬性；手機的右緣漸層（`index.css`）只在帶著它時出現。 */
export const TABLE_MORE_RIGHT_ATTR = "data-kb-more-right";

/** BlockNote 表格的橫向捲動層。 */
const TABLE_SCROLLER = ".tableWrapper";

/** 瀏覽器支援用捲動位置驅動動畫時，漸層純靠 CSS（`index.css`），不需要這支 hook。 */
export function supportsScrollTimeline(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll(self inline)");
}

/** 依目前捲動位置更新一個表格捲動層：右邊還有 1px 以上沒看到才算「還能往右捲」。 */
export function syncTableScrollHint(scroller: HTMLElement): void {
  const more = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
  // 狀態沒變就不寫：重掃時不產生屬性變動。
  scroller.toggleAttribute(TABLE_MORE_RIGHT_ATTR, more);
}

/**
 * 不支援捲動驅動動畫的瀏覽器：在編輯器的捲動容器上用事件委派維護 `TABLE_MORE_RIGHT_ATTR`，不逐表掛監聽。
 * `scroll` 不冒泡，所以用 capture 階段接；開始時、容器或內容大小變動（旋轉、改表格、載入圖片）時重掃一次，
 * 這樣還沒捲過、但已經溢出的表格一開始就有提示，沒溢出的沒有。只在 `enabled`（手機）時工作。
 */
export function useTableScrollHint(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null || supportsScrollTimeline()) return;
    const scrollers = () => root.querySelectorAll<HTMLElement>(TABLE_SCROLLER);
    const syncAll = () => scrollers().forEach(syncTableScrollHint);
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.matches(TABLE_SCROLLER)) syncTableScrollHint(event.target);
    };
    let frame = 0;
    const scheduleSync = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncAll();
      });
    };
    root.addEventListener("scroll", onScroll, true);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleSync) : null;
    resize?.observe(root);
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(scheduleSync) : null;
    // 摺疊區塊展開只改 data-show-children（裡面的表格才有寬度）；不觀察自己寫的屬性。
    mutation?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-show-children"] });
    syncAll();
    return () => {
      root.removeEventListener("scroll", onScroll, true);
      resize?.disconnect();
      mutation?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      scrollers().forEach((scroller) => scroller.removeAttribute(TABLE_MORE_RIGHT_ATTR));
    };
  }, [rootRef, enabled]);
}
