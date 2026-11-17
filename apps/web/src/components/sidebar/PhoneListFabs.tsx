import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PenLine, Search } from "@/components/ui/icons";
import { tourTarget } from "@/lib/tour-targets";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";

interface PhoneListFabsProps {
  /** 開搜尋層並聚焦搜尋框（與點搜尋框同一條路）。 */
  onSearch: () => void;
  /** 垃圾桶 tab 不建筆記，只留搜尋。 */
  showNewNote: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
}

/**
 * 兩顆鈕共用的毛玻璃面：半透明卡片底加背景模糊、細框、陰影同 `CornerStack`。
 * 不支援 `backdrop-filter` 的瀏覽器退回幾乎不透明的底（沒有模糊，透明就會讓下面的字干擾圖示）。
 * 用 `ghost` 當底（沒有自帶的底色與框），hover 與按下只微調透明度，不換成 brand 實心。
 */
const FROSTED =
  "z-10 h-14 w-14 rounded-full border border-black/10 bg-card/95 dark:border-white/20 shadow-lg " +
  "supports-[backdrop-filter]:bg-card/25 supports-[backdrop-filter]:backdrop-blur-xs supports-[backdrop-filter]:backdrop-saturate-150 " +
  "hover:bg-card/95 supports-[backdrop-filter]:hover:bg-card/30 " +
  "active:bg-card/95 supports-[backdrop-filter]:active:bg-card/40";

/**
 * 手機清單與筆記畫面底部的兩顆圓形毛玻璃浮動鈕（各 56px）：左下「Search」、右下「New note」（筆圖示、brand 色），距邊 16px 加 safe area。
 * 兩顆都是 `fixed`，不佔版面；捲動內容自己留底部空白讓最後一列／一行能捲到它們上方。
 * 螢幕鍵盤開著時整組不渲染（搜尋中的搜尋列才是鍵盤上方的那條）；選取模式、搜尋層與編輯中由呼叫端不渲染。
 */
export function PhoneListFabs({ onSearch, showNewNote, onCreateNote, newNotePending }: PhoneListFabsProps) {
  const { t } = useTranslation();
  const inset = useKeyboardInset();
  if (isKeyboardOpen(inset)) return null;
  return (
    <div data-phone-list-fabs="">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-phone-fab="search"
        {...tourTarget("phoneSearch")}
        aria-label={t("sidebar.searchLabel")}
        onClick={onSearch}
        className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-[calc(1rem+env(safe-area-inset-left))] text-foreground hover:text-foreground ${FROSTED}`}
      >
        <Search aria-hidden="true" className="h-5 w-5" />
      </Button>
      {showNewNote && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-phone-fab="new-note"
          {...tourTarget("phoneNewNote")}
          aria-label={t("home.newNote")}
          onClick={onCreateNote}
          disabled={newNotePending}
          className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] text-brand-on-soft hover:text-brand-on-soft ${FROSTED}`}
        >
          <PenLine aria-hidden="true" className="h-[22px] w-[22px]" />
        </Button>
      )}
    </div>
  );
}
