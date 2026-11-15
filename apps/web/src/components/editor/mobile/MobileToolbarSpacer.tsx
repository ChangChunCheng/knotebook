import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { useColorPanelHeight } from "./toolbar-footprint";

/**
 * 手機編輯工具列在時，放在文章欄最尾端的空白：高度＝鍵盤高＋工具列外框高（鍵盤收起時再加 safe area）。
 * 色盤開著時（鍵盤已收、色盤佔著鍵盤的位置）以色盤高度為準。
 * 沒有它，文件捲到底時最後幾行只在螢幕最底 24px，被浮在上面的工具列蓋住，ProseMirror 也沒有可捲的空間把游標推上去。
 */
export function MobileToolbarSpacer() {
  const inset = Math.max(useKeyboardInset(), useColorPanelHeight());
  const height = isKeyboardOpen(inset)
    ? `${inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX}px`
    : `calc(${inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX}px + env(safe-area-inset-bottom))`;
  return <div aria-hidden="true" data-mobile-toolbar-spacer="" className="shrink-0" style={{ height }} />;
}
