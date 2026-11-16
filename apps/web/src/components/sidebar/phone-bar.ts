/**
 * 手機清單畫面底部兩種列（搜尋層開著時的搜尋列 `PhoneListBar`、選取動作列 `SelectActionBar`）共用的外框 class：
 * 內距 6＋控制項 44＋6、上框線，加底部 safe area。兩列同高；沒在搜尋也沒在選取時清單底部沒有列（入口是 `PhoneListFabs`）。
 * 螢幕鍵盤開著時鍵盤蓋住了底部 safe area，所以不留那段內距。
 * 手機上捲的是文件：列是清單畫面最後一個子元素，`sticky` 釘在視窗底；它在文件流裡佔自己的高度，清單最後一列因此捲得到它上方。
 */
export const PHONE_BAR_FRAME = "shrink-0 border-t border-border bg-card px-2 pt-1.5 max-sm:sticky max-sm:bottom-0 max-sm:z-20";

/** 控制項那一列的最小高度（44，觸控目標）。 */
export const PHONE_BAR_CONTROL_HEIGHT = "min-h-11";

export function phoneBarBottomPadding(keyboardOpen: boolean): string {
  return keyboardOpen ? "pb-1.5" : "pb-[calc(0.375rem+env(safe-area-inset-bottom))]";
}

/** 手機清單畫面的頂列（標題與頭像）：捲動時釘在頁面頂端，不透明底、內容不透出。 */
export const PHONE_TOP_BAR_STICKY = "max-sm:sticky max-sm:top-0 max-sm:z-30 max-sm:bg-card";

/**
 * 清單的標題列（tab 名稱與它的動作鈕；選取模式時是選取的標題列，含「完成」）：手機上釘在頂列正下方，
 * 捲到清單中間也按得到。頂列高 48 加上方 safe area（`AppShell` 的 `data-phone-top-bar`）。
 */
export const PHONE_LIST_HEADER_STICKY = "max-sm:sticky max-sm:top-[calc(3rem+env(safe-area-inset-top))] max-sm:z-20 max-sm:bg-card";

/** 清單與搜尋結果的捲動容器：手機上不自己捲（文件在捲），寬版照舊。 */
export const PHONE_LIST_SCROLLER = "max-sm:overflow-y-visible";
