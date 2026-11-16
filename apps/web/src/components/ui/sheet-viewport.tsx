import { useEffect, type RefObject } from "react";
import { readKeyboardInset } from "@/lib/visual-viewport";

/**
 * 手機 sheet（對話框、選單）跟著螢幕鍵盤：只在 sheet 開著（內容有掛載）時訂閱 `visualViewport`，直接把 `--kb-inset`（鍵盤高）與
 * `--kb-visible-h`（視覺視窗高）寫到內容元素上，不觸發 React 重繪；沒有視覺視窗或雙指放大中時兩個變數都移除。
 * 同一幀的多次事件合併成一次讀值。
 */
export function SheetViewportVars({ target }: { target: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const element = target.current;
      if (!element) return;
      // 以縮放判斷而不是以鍵盤高度：iOS 把視覺視窗平移到底時鍵盤高度剛好是 0，但可見高度仍比版面視窗矮。
      if (Math.abs(viewport.scale - 1) <= 0.01) {
        element.style.setProperty("--kb-inset", `${readKeyboardInset()}px`);
        element.style.setProperty("--kb-visible-h", `${viewport.height}px`);
      } else {
        element.style.removeProperty("--kb-inset");
        element.style.removeProperty("--kb-visible-h");
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [target]);
  return null;
}
