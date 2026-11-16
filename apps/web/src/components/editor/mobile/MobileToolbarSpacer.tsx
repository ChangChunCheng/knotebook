import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { useKeyboardInset } from "@/lib/visual-viewport";
import { useColorPanelHeight } from "./toolbar-footprint";

/**
 * 手機編輯工具列在時，放在文章欄最尾端的空白：高度＝鍵盤高＋工具列外框高。
 * 色盤開著時（鍵盤已收、色盤佔著鍵盤的位置）以色盤高度為準。
 * 沒有它，文件捲到底時最後幾行只在螢幕最底 24px，被浮在上面的工具列蓋住，ProseMirror 也沒有可捲的空間把游標推上去。
 * 底部 safe area 不在這裡加：工具列在時內文卡自己留了那一段（`NoteEditor` 的 `max-sm:pb-[env(safe-area-inset-bottom)]`），
 * 捲動容器的下緣已經在 safe area 之上，這裡再加就算了兩次。
 */
export function MobileToolbarSpacer() {
  const inset = Math.max(useKeyboardInset(), useColorPanelHeight());
  return <div aria-hidden="true" data-mobile-toolbar-spacer="" className="shrink-0" style={{ height: `${inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX}px` }} />;
}
