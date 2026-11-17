/**
 * 找功能導覽要指的元素（靠 `lib/tour-targets.ts` 的 `data-kb-tour-target` 屬性），以及導覽怎麼分版面。
 * 只有導覽的 lazy 鏈（`components/tour/*`）與說明視窗的 lazy chunk（`ShortcutsLazy`）import 這支，它不進首包。
 *
 * 導覽的版面判準只住在這裡（`tourLayout`，要跟著視窗變化重畫的元件用 `useTourLayout`）：站點表、引擎、
 * 卡片的說明、結束後找焦點都從這裡取，判準要換時只改這一處；底下的寬度界線在 `lib/layout-tiers.ts`。
 *
 * 每次呼叫都重查 DOM：AppShell 會隨首頁↔筆記頁、筆記頁整頁載入換殼，先前查到的元素可能已經卸載。
 */

import { isOverlay, isPhone, useIsOverlay, useIsPhone } from "@/lib/layout-tiers";
import { TOUR_TARGET_ATTR, type TourTargetId } from "@/lib/tour-targets";

/**
 * 第一個帶這個屬性、而且不在 `aria-hidden="true"` 或 `inert` 範圍內的元素。
 * 側欄有固定卡片與抽屜兩份，屬性兩份都有：抽屜開著時，Radix 會把抽屜以外的整棵樹標成 `aria-hidden`，
 * 所以拿到的是抽屜那份；抽屜關著時只剩固定卡片那份。CSS 造成的不可見（窄視窗下的固定卡片是 `display: none`）
 * 這裡不判斷，導覽另外看元素尺寸。
 */
export function findTourTarget(id: TourTargetId, root: ParentNode = document): Element | null {
  for (const el of root.querySelectorAll(`[${TOUR_TARGET_ATTR}="${id}"]`)) {
    if (el.closest('[aria-hidden="true"], [inert]') === null) return el;
  }
  return null;
}

/**
 * 選取文字時浮出的格式工具列裡、可及名稱等於 `name` 的鈕。工具列是 portal 出來的浮層（外層帶
 * `data-kb-formatting-toolbar-popover`），鈕本身沒有導覽屬性，所以靠名稱找；範圍限在浮層內，使用者的內容不會撞名。
 * 同 `findTourTarget`：在 `aria-hidden`／`inert` 範圍內的不算。
 */
export function findFormattingToolbarButton(name: string): Element | null {
  for (const popover of document.querySelectorAll("[data-kb-formatting-toolbar-popover]")) {
    if (popover.closest('[aria-hidden="true"], [inert]') !== null) continue;
    for (const button of popover.querySelectorAll("button")) {
      if (button.getAttribute("aria-label") === name) return button;
    }
  }
  return null;
}

/** 開抽屜的漢堡鈕：在筆記頁頁首，或沒有頁首的頁面上的窄版頂列（同一時間只會掛其中一顆）。 */
export function findDrawerButton(): Element | null {
  return findTourTarget("drawerButton");
}

/** 使用者選單觸發鈕：寬視窗在側欄卡片底部（抽屜開著時是抽屜裡那顆），手機在清單畫面頂列右邊（頭像）。 */
export function findUserMenuTrigger(): Element | null {
  return findTourTarget("userMenu");
}

/**
 * 導覽用的三種版面：
 * - `wide`：視窗 1280px 以上，側欄固定在左邊。
 * - `floating`：640～1279px，側欄收在抽屜裡（`OVERLAY_QUERY`），入口是頁首的側欄鈕；右下角的版本泡泡還在。
 * - `phone`：比 640px 窄（`PHONE_QUERY`）。沒有抽屜也沒有側欄鈕：清單是首頁（tab 列、資料夾、底部圓形的搜尋與新增筆記鈕、
 *   頂列的頭像＝使用者選單），筆記是另一個畫面（左上的「‹」回清單）；版本歷史在 ⋮ 裡，沒有浮出的格式工具列。
 */
export type TourLayout = "wide" | "floating" | "phone";

export function tourLayout(): TourLayout {
  if (isPhone()) return "phone";
  return isOverlay() ? "floating" : "wide";
}

/** 同 `tourLayout`，視窗跨過 640 或 1280 時重畫（訂閱 `layout-tiers` 的兩個 hook，不另外查 `matchMedia`）。 */
export function useTourLayout(): TourLayout {
  const phone = useIsPhone();
  const overlay = useIsOverlay();
  if (phone) return "phone";
  return overlay ? "floating" : "wide";
}

/**
 * 導覽結束後要聚焦的使用者選單觸發鈕（傳給 `start` 的 `returnFocus`）：寬視窗是側欄卡片底部的帳號列；
 * 側欄浮動時使用者選單在已經關掉的抽屜裡，改回開抽屜的側欄鈕；手機是清單頂列的頭像（導覽在手機上結束時停在清單）。
 */
export function findUserMenuReturnTarget(): Element | null {
  return tourLayout() === "floating" ? findDrawerButton() : findUserMenuTrigger();
}
