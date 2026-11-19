import { useEffect } from "react";

/** On `columnEl` during any drag; `index.css` uses it to disable pointer hits on the overlays outside the editor (⋮⋮, dividers). */
export const DRAG_ACTIVE_CLASS = "kb-dragging";

/**
 * ⋮⋮ and dividers sit outside `view.dom` and nothing calls `preventDefault` on dragover for them, so a drop on them is rejected
 * (in-app drag fails, external files get opened by the browser); disabling their hit-testing lets the events reach the editor.
 * Add on capture `dragenter` (drags from the OS or other windows fire no dragstart here) and on `dragover` (restores a class a stray pointermove cleared).
 * Clear on `drop`, `dragend`, and the first `pointermove` while the class is set: browsers send no pointer moves during an HTML5 drag, so one means it ended (including leaving the window).
 * `dragleave` is not used: the new element's dragenter fires before the old one's dragleave and `relatedTarget` isn't reliable, so one misread would drop the class mid-drag.
 */
export function useDragActiveClass(columnEl: HTMLElement | null): void {
  useEffect(() => {
    if (!columnEl) return;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const add = () => columnEl.classList.add(DRAG_ACTIVE_CLASS);
    const remove = () => columnEl.classList.remove(DRAG_ACTIVE_CLASS);
    document.addEventListener("dragenter", add, options);
    document.addEventListener("dragover", add, options);
    document.addEventListener("drop", remove, options);
    document.addEventListener("dragend", remove, options);
    document.addEventListener(
      "pointermove",
      () => {
        if (columnEl.classList.contains(DRAG_ACTIVE_CLASS)) remove();
      },
      options,
    );
    return () => {
      controller.abort();
      remove();
    };
  }, [columnEl]);
}
