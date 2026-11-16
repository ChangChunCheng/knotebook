import { cn } from "@/lib/utils";

/**
 * 管理面板托盤（#247）的 class：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。
 * `ManagementShell`（站台管理／群組／設定）與快捷鍵介紹頁（`ShortcutsDialog`）共用，改托盤只動這裡。
 */
export const managementTray =
  "flex h-full min-h-0 w-full min-w-0 gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3 " +
  // 手機（< 640）面板是貼底的 sheet（`ui/dialog.tsx` 的 panel），一次只顯示一張卡：托盤不留內距、不投影，卡直接貼齊 sheet 的左右與底，
  // 與選單的 sheet 一樣滿版；左右與底的 safe area 由卡自己當內距（見下面三個常數）。
  "max-sm:gap-0 max-sm:p-0 max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:shadow-none max-sm:bg-transparent max-sm:backdrop-blur-none";

/** 手機：卡就是 sheet 的表面——貼齊左右與底，只留上圓角，左右與底沒有邊框（同選單 sheet）。 */
export const managementCardPhone = "max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:bg-popover";

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
    // 手機：項次清單是「點進去」的清單、不是選取中的導覽，長相同選單 sheet 的列——至少 48px 高、16px 一般字重、列與列相貼、4px 圓角、
    // 灰色的按壓／焦點底色，沒有常駐的品牌色（目前所在的項次也一樣）。列往兩側各多出 8px（`-mx-2`）、內距 8px（`px-2`）：底色離卡緣 8px，文字與列尾的「›」離卡緣 16px（同選單 sheet 的列）。
    "max-sm:-mx-2 max-sm:h-auto max-sm:min-h-12 max-sm:rounded-sm max-sm:px-2 max-sm:text-base max-sm:font-normal max-sm:text-foreground " +
      "max-sm:hover:bg-accent max-sm:hover:text-foreground max-sm:active:bg-accent max-sm:focus-visible:bg-accent",
    active && "max-sm:bg-transparent max-sm:font-normal max-sm:text-foreground max-sm:hover:bg-accent",
  );
}

/** 手機項次清單的列互相貼齊（桌面是 4px 的間距）。 */
export const managementNavListClass = "flex flex-col gap-1 max-sm:gap-0";

/**
 * 手機項次清單最上面一列（「‹」＋標題）與清單之間的髮絲線，同選單 sheet 的分隔線——線拉滿卡的全寬（往兩側退掉卡的內距，內距含 safe area）；
 * 列高讓「‹」與標題垂直置中；標題的左緣（卡內距＋讓出「‹」的 40px）不因列變寬而動。
 */
export const managementListHeaderPhone =
  "max-sm:mb-2 max-sm:h-12 max-sm:border-b max-sm:border-border " +
  "max-sm:-ml-[max(1rem,env(safe-area-inset-left))] max-sm:-mr-[max(1rem,env(safe-area-inset-right))] " +
  "max-sm:pl-[calc(max(1rem,env(safe-area-inset-left))+2.5rem)] max-sm:pr-[max(1rem,env(safe-area-inset-right))]";

/**
 * 手機：「‹」與項次清單標題（高 48px，卡內距 16px）垂直置中；內容層的標題同高，兩層的「‹」才落在同一個位置。
 * 底色就是 sheet 的表面（看起來是透明的），但捲動的內容從它底下經過時會被遮住，不會與「‹」的符號重疊。
 */
export const managementBackTopPhone = "max-sm:top-[26px] max-sm:bg-popover";

/**
 * 手機內容層：內容區頂端留出「‹」的位置（符號到 54px、點擊範圍到 62px），讓載入中、載入失敗、找不到這類沒有自己標題的內容不落在「‹」底下；
 * 有標題的頁（`SettingsPage` 的 h1、快捷鍵的分類標題）再用 `managementHeadingUpPhone` 往上拉回與「‹」同高。
 */
export const managementContentTopPhone = "max-sm:pt-16";

/** 手機：標題（高 48px）往上拉 48px，中線落在「‹」的中線（40px）。與 `managementContentTopPhone` 成對。 */
export const managementHeadingUpPhone = "max-sm:-mt-12 max-sm:flex max-sm:min-h-12 max-sm:items-center max-sm:pl-10";
