import { useEffect, type RefObject } from "react";
import { readKeyboardInset } from "@/lib/visual-viewport";

/** Subscribes to `visualViewport` only while the sheet is open and writes `--kb-inset` (keyboard height) and `--kb-visible-h` (visual viewport height) straight onto the content element, without React re-renders; both are removed when there is no visual viewport or while pinch-zooming. Events in one frame coalesce into one read. */
export function SheetViewportVars({ target }: { target: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const element = target.current;
      if (!element) return;
      // Judged by zoom, not keyboard height: when iOS pans the visual viewport to the bottom the keyboard height is exactly 0, yet the visible height is still shorter than the layout viewport.
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
