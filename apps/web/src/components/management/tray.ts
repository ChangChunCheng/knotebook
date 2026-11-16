import { cn } from "@/lib/utils";

/**
 * 管理面板托盤（#247）的 class：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。
 * `ManagementShell`（站台管理／群組／設定）與快捷鍵介紹頁（`ShortcutsDialog`）共用，改托盤只動這裡。
 */
export const managementTray =
  "flex h-full min-h-0 w-full min-w-0 gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3 " +
  // 手機（< 640）面板是貼底的 sheet（`ui/dialog.tsx` 的 panel），一次只顯示一張卡：托盤不留內距、不投影，卡直接貼齊 sheet 的左右與底，
  // 與選單的 sheet 一樣滿版；左右與底的 safe area 由卡自己當內距（見下面三個常數）。
  "max-sm:gap-0 max-sm:p-0 max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:shadow-none";

/** 手機：卡就是 sheet 的表面——貼齊左右與底，只留上圓角，左右與底沒有邊框（同選單 sheet）。 */
export const managementCardPhone = "max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0";

/** 手機：本身沒有內距的卡（內容卡）把左右與底的 safe area 當內距（橫拿時的側邊、Home 指示條），不往外退。 */
export const managementCardPhoneInset =
  "max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)] max-sm:pb-[env(safe-area-inset-bottom)]";

/** 手機：自帶 16px 內距的卡（項次清單）：內距與 safe area 取大。 */
export const managementListPaddingPhone =
  "max-sm:pl-[max(1rem,env(safe-area-inset-left))] max-sm:pr-[max(1rem,env(safe-area-inset-right))] max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]";

/**
 * 左欄項次的 class（`ManagementShell` 的 `ManagementNavItem` 與快捷鍵介紹頁的分類鈕共用——兩者是同一種視覺語彙，
 * 差別只在一個是 NavLink、一個是 state 驅動的按鈕）。`active`＝目前所在項次。
 */
export function managementNavItemClass(active: boolean): string {
  return cn(
    "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors " +
      "hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
    active && "bg-brand-soft font-medium text-brand-on-soft hover:bg-brand-soft-strong",
  );
}
