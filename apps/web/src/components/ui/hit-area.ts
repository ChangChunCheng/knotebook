/**
 * 觸控裝置（`pointer: coarse`）的點擊範圍：視覺大小不變，用 `::after` 向外撐出看不見的點擊面。
 * 滑鼠（`pointer: fine`）沒有任何變化。
 *
 * - `ROW_ICON_HIT`：側欄列內 24px 圖示鈕（筆記／資料夾／群組列的 ⋮ 與「＋」與最愛星號、垃圾桶列的「還原」與 ⋮、
 *   標題列的「選取」「＋」「清空」）。四邊各撐 10px＝44×44。帶一個 `row-icon` 標記 class，給 `ROW_ICON_ROW` 認。
 * - `ROW_ICON_ROW`：放在**含這些鈕的那一列容器**上。觸控時列的 gap 固定 4px，後面緊接著另一顆 `row-icon` 的那一顆右側再多留 16px
 *   （24＋4＋16＝圓心距 44，剛好不蓋住），點擊範圍一般不會互相蓋住（有框線的 `ROW_ICON_HIT_BORDERED` 緊鄰時例外）；鈕與名稱之間的間距不變。
 *   間距加在前一顆上，所以 `display: none` 的那一顆（例如觸控時隱藏的未加入最愛星號）不會把後面的鈕多推開。
 * - `HEADER_ICON_HIT`：筆記頁頁首 32px 圖示鈕（星號、分享、寬度、⋮、「‹」、側欄鈕）。左右各撐 4px、上下各撐 6px＝40×44；
 *   頁首鈕之間的間距是 8px，圓心距 40，剛好不重疊。
 *
 * ⚠ 每個 class 必須是完整字面（Tailwind 靜態掃描原始碼產生 CSS）；`relative` 是 `::after` 絕對定位的錨點。
 * ⚠ 測試只能斷言 class 字串；真的撐到 44 要在瀏覽器量。祖先若有 `overflow` 裁切，超出的那一塊點不到。
 */
export const ROW_ICON_HIT =
  "row-icon relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']";

/**
 * `ROW_ICON_HIT` 的有框線版（`variant="outline"` 的 24px 鈕，例如選取模式的「Done」）：`::after` 的定位從框線內側算起，
 * 所以四邊各撐 11px 才補回 1px 框線，總共 44。其餘（`row-icon` 標記、只在粗指標生效）與 `ROW_ICON_HIT` 相同。
 * 跟「Select all」相鄰時，兩顆的點擊範圍會重疊 1px。
 */
export const ROW_ICON_HIT_BORDERED =
  "row-icon relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[11px] pointer-coarse:after:content-['']";

export const ROW_ICON_ROW = "pointer-coarse:gap-1 pointer-coarse:[&>.row-icon:has(+.row-icon)]:me-4";

export const HEADER_ICON_HIT =
  "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:content-['']";

/**
 * 蓋在輸入框裡面的 24px 圖示鈕（搜尋框的清除 ✕）。鈕本身已是 `absolute`（定位錨點），所以不帶 `relative`，
 * 否則兩個定位 class 互相蓋掉。四邊各撐 10px＝44×44。鈕靠右 4px、寬 24px，點擊範圍的左緣離輸入框右緣 38px；
 * 所以觸控時輸入框右內距要 ≥ 41px（`pointer-coarse:pr-10`＝40px 加 1px 邊框），字才不會被點擊範圍蓋到。
 */
export const FIELD_ICON_HIT = "pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']";
