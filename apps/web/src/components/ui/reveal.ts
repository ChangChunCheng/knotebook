/**
 * 側欄與設定頁頭貼候選格 ⋮ 的「滑過才浮出」（側欄那幾顆是 button.tsx 規範的 24px 例外）。`noterow` 的使用者：筆記列 ⋮
 * （`NoteMenu.tsx`）與垃圾桶列的「還原」、⋮（`sidebar/TrashPanel.tsx`）；列 `<li>` 帶 `group/noterow`。
 * `folderrow`：資料夾列的「在 X 建立筆記」與 ⋮（列帶 `group/folderrow`）。
 * `avatarcell`：設定頁頭貼候選格的 ⋮（整個候選格區塊帶 `group/avatarcell`，滑過區塊內任何地方，各格的 ⋮ 一起浮出）。
 * - 桌面：平常 `opacity-0`；滑過該列（`group-hover/<scope>`）、列內有鍵盤焦點
 *   （`group-has-[:focus-visible]/<scope>`——不用 focus-within，滑鼠點完留下的焦點會讓它殘留）、自己被鍵盤聚焦時浮出。
 * - 選單開著時不消失：Radix trigger 開啟時帶 `data-state="open"`；modal 選單開著時指標已離開列，
 *   沒有這條 ⋮ 會在選單還開著時淡掉。對非選單的「＋」沒有作用（它不帶 data-state）。
 * - 觸控（`hover: none`）常駐：Tailwind v4 的 group-hover 只在 `@media (hover: hover)` 生效。
 * `hoverRevealOnly` 與 `hoverReveal` 的差別只在觸控：⋮ 在觸控裝置要常駐（唯一入口），列上的空心星星相反——
 * `hover: none` 或 `pointer: coarse` 時整顆 `display: none`（不佔位、不在 Tab 順序與無障礙樹），加入改走 ⋮。
 * ⚠ 每個 scope 的 class 必須是**完整字面**——Tailwind 靜態掃描原始碼產生 CSS，
 *   樣板字串拼出來的 class 不會被產生（靜默失效，jsdom 測試照綠）。
 * ⚠ 測試只能斷言 class 字串（jsdom 沒有 CSS、沒有 hover）；真的滑過會浮出要在瀏覽器看。
 */
export type RevealScope = "grouprow" | "noterow" | "folderrow" | "avatarcell";

const BASE =
  "opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:none)]:opacity-100 data-[state=open]:opacity-100";

const SCOPE: Record<RevealScope, string> = {
  grouprow: "group-hover/grouprow:opacity-100 group-has-[:focus-visible]/grouprow:opacity-100",
  noterow: "group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100",
  folderrow: "group-hover/folderrow:opacity-100 group-has-[:focus-visible]/folderrow:opacity-100",
  avatarcell: "group-hover/avatarcell:opacity-100 group-has-[:focus-visible]/avatarcell:opacity-100",
};

export function hoverReveal(scope: RevealScope): string {
  return `${BASE} ${SCOPE[scope]}`;
}

/** 只在滑鼠／鍵盤裝置浮出、觸控裝置整顆隱藏（見檔頭）。目前只有 `noterow`；每個 class 一樣必須是完整字面。 */
const REVEAL_ONLY = {
  noterow:
    "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
} as const;

/**
 * 筆記列 ⋮ 專用（滑鼠）：在 flex 流裡，順序是標題、⋮、星號（星號永遠在最右一格不動）。沒浮出時寬度 0（`-ms-1` 抵掉多出的一個 gap），不佔位；
 * 列被滑過、列內有鍵盤焦點、自己被聚焦或選單開著時長成 24px，標題因此更早截斷，不會被蓋住。
 * 零寬的鈕仍可被 Tab 聚焦（不是 `display: none`），聚焦後 `focus-visible` 讓它長出來。沒有星號時 ⋮ 自己是最右一格。
 * 觸控與沒有 hover 的裝置（`hover: none`，⋮ 常駐）一律 24px（`!` 蓋過上面的寬度 0）。
 * 指標沒滑過列時 Playwright 對零寬的鈕沒辦法 hover／click：測試先 hover 整列再點 ⋮。
 */
export const NOTE_MENU_COLLAPSE =
  "pointer-fine:w-0 pointer-fine:-ms-1 pointer-fine:overflow-hidden pointer-fine:group-hover/noterow:w-6 pointer-fine:group-hover/noterow:ms-0 pointer-fine:group-has-[:focus-visible]/noterow:w-6 pointer-fine:group-has-[:focus-visible]/noterow:ms-0 pointer-fine:focus-visible:w-6 pointer-fine:focus-visible:ms-0 pointer-fine:data-[state=open]:w-6 pointer-fine:data-[state=open]:ms-0 [@media(hover:none)]:w-6! [@media(hover:none)]:ms-0!";

/** 筆記列的最愛星號在觸控（`pointer: coarse`）與沒有 hover 的裝置上整顆不顯示（不佔位、不在 Tab 順序與無障礙樹）：加入、移出最愛都走 ⋮。 */
export const NOTE_STAR_TOUCH_HIDDEN = "[@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden";

export function hoverRevealOnly(scope: keyof typeof REVEAL_ONLY): string {
  return REVEAL_ONLY[scope];
}
