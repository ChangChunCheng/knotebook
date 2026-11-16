import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "@/components/ui/icons";
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
 * 手機清單畫面底部的兩顆圓形浮動鈕（各 56px）：左下「Search」、右下「New note」，距邊 16px 加 safe area，陰影同 `CornerStack`。
 * 兩顆都是 `fixed`，不佔版面；清單自己留底部內距讓最後一列能捲到它們上方。
 * 螢幕鍵盤開著時整組不渲染（搜尋中的搜尋列才是鍵盤上方的那條）；選取模式與搜尋層由呼叫端不渲染。
 */
export function PhoneListFabs({ onSearch, showNewNote, onCreateNote, newNotePending }: PhoneListFabsProps) {
  const { t } = useTranslation();
  const inset = useKeyboardInset();
  if (isKeyboardOpen(inset)) return null;
  return (
    <div data-phone-list-fabs="">
      <Button
        type="button"
        variant="outline"
        size="icon"
        data-phone-fab="search"
        aria-label={t("sidebar.searchLabel")}
        onClick={onSearch}
        className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-[calc(1rem+env(safe-area-inset-left))] z-10 h-14 w-14 rounded-full border border-border bg-card shadow-lg"
      >
        <Search aria-hidden="true" className="h-5 w-5" />
      </Button>
      {showNewNote && (
        <Button
          type="button"
          variant="brand"
          size="icon"
          data-phone-fab="new-note"
          aria-label={t("home.newNote")}
          onClick={onCreateNote}
          disabled={newNotePending}
          className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-10 h-14 w-14 rounded-full border border-border shadow-lg"
        >
          <Plus aria-hidden="true" className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
}
