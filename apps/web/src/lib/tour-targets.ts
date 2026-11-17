/**
 * 功能導覽要指的畫面元素，一律靠元件上的 `data-kb-tour-target` 屬性找，不比可及名稱或文字：
 * 側欄裡到處是使用者自己取的名字（資料夾、筆記標題，選取模式的資料夾鈕還拿資料夾名當 `aria-label`），
 * 用名稱找遲早會撞到。屬性只掛在真正的目標元件上（`tourTarget(id)` 展開到元件的 props），使用者內容不會帶它。
 *
 * 這支在首包：只放屬性名、目標 id 與 `tourTarget`，不 import 任何東西。查找目標、判斷版面的程式在 `lib/tour-find.ts`，
 * 只有導覽的 lazy 鏈與說明視窗的 lazy chunk 用得到。
 */

export type TourTargetId =
  | "tabs"
  | "newNote"
  | "newFolder"
  | "search"
  | "share"
  | "noteMenu"
  | "noteWidth"
  | "versions"
  | "userMenu"
  | "drawerButton"
  | "backToList"
  | "phoneNewNote"
  | "phoneSearch"
  | "wikilinkMenu"
  | "slashMenu"
  | "wikilink"
  | "flowchart";

export const TOUR_TARGET_ATTR = "data-kb-tour-target";

/** 展開到目標元件的 props：`<Button {...tourTarget("newNote")}>`。 */
export function tourTarget(id: TourTargetId): { "data-kb-tour-target": TourTargetId } {
  return { "data-kb-tour-target": id };
}
