import { lazy, Suspense, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { X } from "@/components/ui/icons";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { managementCardPhone, managementTray } from "@/components/management/tray";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/**
 * 內容（分類清單、字串、鍵面）在 lazy chunk，第一次打開才下載；外殼（這個檔）在首包，只有對話框骨架。
 * `ShortcutsLazy` 模組頂層註冊字串包——別從首包任何地方 import 它（scripts/check-bundle-size.mjs 會紅）。
 */
const ShortcutsContent = lazy(() => import("@/components/shortcuts/ShortcutsLazy").then((m) => ({ default: m.ShortcutsContent })));

/** chunk 下載中與載入失敗時佔住右邊整塊托盤的一張卡（標題、✕、Esc 都在外殼，所以這兩個狀態下對話框一樣關得掉）。 */
// 手機：卡貼齊 sheet 底緣，底部內距與 Home 指示條的 safe area 取大。
const FALLBACK_CARD = cn(cardSurface, "min-w-0 flex-1 overflow-y-auto p-8 pt-12 max-sm:pb-[max(2rem,env(safe-area-inset-bottom))]", managementCardPhone);

/**
 * 快捷鍵介紹頁的對話框外殼（Ctrl+/ 或使用者選單「快捷鍵介紹」；開關 state 與監聽器在 `AppShell`）。
 * 版面沿用設定的托盤＋兩張卡（左：分類、右：所選分類的條目），兩張卡在 lazy chunk 裡（`ShortcutsLazy`）。
 * 這裡持有的是「不依賴 chunk」的部分：Dialog、sr-only 的標題與描述（對話框的名稱）、✕、托盤、焦點進出。
 *
 * 焦點：
 * - 開啟：聚焦內容區（`onOpenAutoFocus` preventDefault 後自己 focus）；chunk 還沒到時先聚焦對話框本身，內容元件掛上後自己接手。
 *   DOM 順序是 ✕ → 左欄分類 → （窄螢幕的返回鈕）→ 內容區，Radix FocusScope `loop` 讓 Tab 在內容區與 ✕ 之間循環。
 * - 關閉：沒有 `DialogTrigger` 的受控 Dialog，Radix 關閉時不還焦點、落在 body——所以 `onCloseAutoFocus` preventDefault 後
 *   聚焦 `returnFocusRef`（鍵盤開的＝開啟當下的焦點元素；選單開的＝UserMenu 的觸發鈕）。
 * - ⚠ `DialogTitle` 不得傳 `id`：Radix 的 Title 是 `{ id: context.titleId, ...props }`，傳了會蓋掉 context 的 id，
 *   Content 的 `aria-labelledby` 仍指 `context.titleId` → 對話框沒有名稱。
 *
 * 手機（< 640）：貼底的 sheet，沒有 ✕，與管理面板同一套返回堆疊（`ManagementShell` 檔頭）：打開時先停在分類清單；
 * 內容層的「‹」回分類清單，分類清單的「‹」關掉——從選單開的（`reopenMenuRef`）在收下去之後重開那個選單（名稱「返回選單」），
 * 否則只關（名稱「關閉」）。點上方變暗的縫或 Esc 整個關掉。
 *
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` 內（擺放不變量見 ErrorBoundary.tsx）。卡面一律 `cn(cardSurface, …)`（card.guard.test.ts）。
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  returnFocusRef,
  reopenMenuRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  /** 開啟它的選單怎麼重開（`ShortcutsDialogApi.open` 的 `reopenMenu`）；null＝不是從選單開的。 */
  reopenMenuRef?: RefObject<(() => void) | null>;
}) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  /** 分類清單的「‹」按下：收完之後重開選單（而不是還焦點）。 */
  const backToMenuRef = useRef(false);
  // 打開當下是不是手機寬度：「返回選單」只給在手機上從選單打開的情形（在 640 以上打開、之後縮到手機寬度的，清單的「‹」只關）。
  const [phoneAtOpen, setPhoneAtOpen] = useState<boolean | null>(null);
  if (open && phoneAtOpen === null) setPhoneAtOpen(isPhone());
  else if (!open && phoneAtOpen !== null) setPhoneAtOpen(null);
  const canReturnToMenu = phoneAtOpen === true && (reopenMenuRef?.current ?? null) !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="panel"
        data-shortcuts-dialog=""
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          // 看得見的那一層的落點（內容區，或手機停在分類清單時清單的「‹」），見 `ShortcutsLazy`。
          (dialog.querySelector<HTMLElement>("[data-shortcuts-focus]") ?? dialog).focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          const reopen = backToMenuRef.current ? (reopenMenuRef?.current ?? null) : null;
          backToMenuRef.current = false;
          if (reopenMenuRef) reopenMenuRef.current = null;
          if (reopen) reopen();
          else if (el?.isConnected) el.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("shortcuts.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("shortcuts.description")}</DialogDescription>
        <div className={cn(managementTray, "relative")}>
          {/* 唯讀說明頁：不需要設定那種「點外面不關」的保護，✕／Esc／點外面都能關。✕ 在 DOM 最前面（落在托盤右上角）。 */}
          {!phone && (
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-4 top-4 z-20 h-7 w-7 bg-card md:right-5 md:top-5"
                aria-label={t("management.close")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogClose>
          )}
          <LazyRouteErrorBoundary resetKey={undefined} chunk="shortcuts" frame="inline" inlineErrorClassName={FALLBACK_CARD}>
            <Suspense
              fallback={
                <div className={FALLBACK_CARD}>
                  <LazyRouteLoading frame="inline" />
                </div>
              }
            >
              <ChunkLoadBeacon chunk="shortcuts" />
              <ShortcutsContent
                listBack={
                  phone
                    ? {
                        label: canReturnToMenu ? t("management.backToMenu") : t("management.close"),
                        onBack: () => {
                          backToMenuRef.current = canReturnToMenu;
                          onOpenChange(false);
                        },
                      }
                    : undefined
                }
              />
            </Suspense>
          </LazyRouteErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
