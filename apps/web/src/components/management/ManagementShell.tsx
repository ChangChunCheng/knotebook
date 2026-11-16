import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ChevronLeft, X } from "@/components/ui/icons";
import {
  managementCardPhone,
  managementCardPhoneInset,
  managementListPaddingPhone,
  managementNavItemClass,
  managementTray,
} from "@/components/management/tray";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { forgetPanelReturn, panelReturnFor, type PanelLocationState } from "@/lib/panel-return";
import { cn } from "@/lib/utils";

/** 28px 的 ✕／返回鈕在觸控裝置撐出 44×44 的點擊範圍（四邊各 8px）；用在 `absolute` 的鈕，`relative` 由呼叫端視需要加。 */
const PANEL_CLOSE_HIT = "pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";
/** 手機的「‹」不分指標一律 44×44（滑鼠縮到手機寬度也一樣）。 */
const PHONE_BACK_HIT = "max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']";
/** 手機的卡貼齊 sheet 左緣：「‹」自己退開左側 safe area（橫拿時的側邊），至少與其他寬度一樣離卡緣 8px。 */
const PHONE_BACK_LEFT = "max-sm:left-[max(0.5rem,env(safe-area-inset-left))]";

/**
 * 三個設定管理類面板（個人設定、群組、站台管理）的共用外殼（#247）：托盤上兩張卡——
 * 左卡項次、右卡內容，與筆記頁「側欄卡＋內文卡」同一語彙。Dialog 由這裡持有；三個薄包裝
 * （`settings/SettingsModal`、`groups/GroupModal`、`admin/AdminModal`）只算 `onOpenChange`
 * 並把 boundary＋Suspense＋`<Outlet/>` 當 children 傳進來。
 *
 * 窄視窗（< md）是**雙層**：一次只顯示一張卡，`layer` 決定是項次層還是內容層；
 * `md:` 以上兩卡恆顯示、`layer` 無作用。兩卡的基底 class 不帶 `flex`，display 全由 layer class
 * 決定、`cn` 合併時放最後——基底若帶 `flex`，twMerge 會把它與 `hidden` 合併成後者，
 * 但只要有人改成字串串接，`flex hidden` 並存、被隱藏的卡就會露出來（測試釘「被隱藏的卡不含裸 flex」）。
 *
 * 焦點：
 * - 開啟：不寫 `onOpenAutoFocus`。Radix FocusScope 的自動聚焦會 `removeLinks` 濾掉所有 `<a>`，
 *   項次（NavLink）永遠不會被選中；落點依右卡 DOM 順序＝返回鈕（窄）或 ✕（寬，返回鈕 display:none）。
 *   所以右卡子節點順序固定：返回鈕 → ✕ → 內容容器。
 * - 返回／點項次（只在窄視窗）：目標元素要等 `setLayer` commit 後才脫離 `display:none`，在 click
 *   handler 裡同步 `focus()` 真瀏覽器會靜默失敗（jsdom 看不出來）。所以只設 `focusRequest`，由
 *   `useLayoutEffect` 在 commit 後聚焦；`seq` 每次遞增，點「目前所在」項次（layer、pathname 都不變）也會觸發。
 * - 點項次走 `onClick`（`onSelect`），不監聽 pathname：點目前所在的項次 pathname 不會變，也要切到內容層。
 *
 * 手機（< 640）：面板是貼底、幾乎滿高的 sheet（`ui/dialog.tsx` 的 panel），導覽是返回堆疊，沒有 ✕——兩層的左上角同一個位置
 * 各有一顆「‹」：內容層的回項次清單；項次清單的關掉 sheet，面板是從選單打開的（`lib/panel-return.ts`）就在 sheet 收下去之後重開那個選單，
 * 可及名稱「返回選單」，否則只關、名稱「關閉」。從選單或快捷鍵打開（導覽 state 的 `panelStart: "list"`）先停在項次清單；
 * 深連結（直接進某一頁的網址、分享框的「管理成員」）直接停在那一頁。點 sheet 上方變暗的縫或按 Esc 一律整個關掉。
 * 手機關閉時先讓 sheet 收下去（`kb-sheet` 動畫），收完（`onCloseAutoFocus`）才呼叫 `onOpenChange(false)`（導回背景頁）；640 以上照舊立即關。
 */

export interface ManagementNavItemSpec {
  to: string;
  label: string;
  /** 轉給 NavLink：群組 modal 的「成員」是 `/groups/:id`，不帶 end 會在子頁也高亮。 */
  end?: boolean;
  /** 列右側灰字計數，可省。 */
  count?: ReactNode;
}

export interface ManagementShellProps {
  /** 左卡標題列＝唯一的 DialogTitle。 */
  title: string;
  /** 標題下的副文字（群組 modal 的我的角色）。 */
  subtitle?: string;
  /** sr-only 的 DialogDescription；省略時用 title。 */
  description?: string;
  items: ManagementNavItemSpec[];
  /** Esc、✕ 與手機項次清單的「‹」都經過這裡（手機是 sheet 收完之後才呼叫）。 */
  onOpenChange: (open: boolean) => void;
  /** 右卡內容（各面板的 ErrorBoundary＋Suspense＋<Outlet/>）。 */
  children: ReactNode;
}

type Layer = "items" | "content";
interface FocusRequest {
  target: Layer;
  seq: number;
}

/** `md` 斷點（768px）。matches === false ＝ 窄視窗，才做焦點搬移。 */
const WIDE_QUERY = "(min-width: 768px)";
function isNarrowViewport(): boolean {
  return !window.matchMedia(WIDE_QUERY).matches;
}

/**
 * 一條左卡項次。`state={backgroundLocation ? { backgroundLocation } : undefined}` 一律轉傳——
 * 沒有這個，項次互切一次之後 `location.state` 就變 undefined，關閉 modal 時找不回原本的背景頁，
 * 只能落回 `/`（靜默扯掉背景 `/n/…` 的共編 provider）。此不變量原本寫在 `SettingsModal.tsx` 的
 * `SettingsNavLink`，#247 搬來這裡，三個面板共用。
 */
export function ManagementNavItem({
  to,
  label,
  end,
  count,
  backgroundLocation,
  onSelect,
}: ManagementNavItemSpec & { backgroundLocation: Location | undefined; onSelect: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      state={backgroundLocation ? { backgroundLocation } : undefined}
      onClick={onSelect}
      className={({ isActive }) => managementNavItemClass(isActive)}
    >
      <span className="min-w-0 truncate">{label}</span>
      {/* aria-hidden：計數只是視覺輔助，連結的可及名稱維持項次名（e2e 以名稱找項次）。 */}
      {count !== undefined && (
        <span aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
          {count}
        </span>
      )}
    </NavLink>
  );
}

export function ManagementShell({ title, subtitle, description, items, onOpenChange, children }: ManagementShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  const phone = useIsPhone();
  // 開啟當下的導覽 state：項次互切之後 state 只剩 backgroundLocation，所以只在掛載時讀一次。
  const [entry] = useState(() => {
    const state = location.state as PanelLocationState | null;
    return { startList: state?.panelStart === "list" && isPhone(), returnToken: state?.panelReturn };
  });
  // 初值 "content"：索引 route 都在 modal 外轉到第一個項次（群組的 /groups/:id 本身就是「成員」），
  // modal 掛上時 URL 必定指著一個項次；深連結在手機上也要直接看到那一頁。手機從選單／快捷鍵打開時停在項次清單。
  const [layer, setLayer] = useState<Layer>(entry.startList ? "items" : "content");
  const [open, setOpen] = useState(true);
  /** 手機關閉中：sheet 收完後要做的事（null＝不是由這裡關的）。 */
  const afterCloseRef = useRef<{ reopen: (() => void) | null } | null>(null);
  // 「返回選單」只給在手機上從選單打開、而且那個選單還能重開的情形；在 640 以上打開、之後縮到手機寬度的，清單的「‹」只關。
  const canReturnToMenu = entry.startList && phone && panelReturnFor(entry.returnToken) !== null;
  const navigate = useNavigate();
  // 讀過之後把 `panelStart`／`panelReturn` 從這一筆歷史拿掉（replace）：重新整理或上一頁／下一頁回到這一筆時當成深連結
  // （停在網址那一頁、清單的「‹」只關），不會再停在清單或重開一個早就不在的選單。
  useEffect(() => {
    const state = location.state as PanelLocationState | null;
    if (state?.panelStart === undefined && state?.panelReturn === undefined) return;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: state.backgroundLocation ? { backgroundLocation: state.backgroundLocation } : null },
    );
  }, [location, navigate]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const seqRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  function switchTo(target: Layer): void {
    setLayer(target);
    if (!isNarrowViewport()) return; // md 以上維持 NavLink 的原生焦點行為
    seqRef.current += 1;
    setFocusRequest({ target, seq: seqRef.current });
  }

  /** 關掉面板；`backToMenu`＝項次清單的「‹」（從選單開的就重開那個選單）。 */
  function close(backToMenu: boolean): void {
    const reopen = backToMenu && entry.startList ? panelReturnFor(entry.returnToken) : null;
    forgetPanelReturn(entry.returnToken);
    if (!isPhone()) {
      onOpenChange(false);
      return;
    }
    afterCloseRef.current = { reopen };
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (focusRequest === null) return;
    if (focusRequest.target === "content") {
      contentRef.current?.focus();
    } else {
      const nav = navRef.current;
      const current = nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>("a");
      current?.focus();
    }
    setFocusRequest(null);
  }, [focusRequest]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close(false);
      }}
    >
      {/* 640 以上點外面不關：內容區的 inline 表單（改密碼、改名…）有未存輸入；Esc／✕ 照常關閉。
          手機是 sheet：點上方變暗的縫就是「離開」，與 Esc 一樣整個關掉。 */}
      <DialogContent
        size="panel"
        dismissOnOutside={phone}
        onCloseAutoFocus={(event) => {
          const after = afterCloseRef.current;
          if (after === null) return;
          afterCloseRef.current = null;
          // 要重開選單時焦點交給選單，不還給開啟前的元素（它在選單裡、已卸載）。
          if (after.reopen) event.preventDefault();
          onOpenChange(false);
          after.reopen?.();
        }}
      >
        {/* 托盤：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。 */}
        <div className={managementTray}>
          <div
            data-management-card="items"
            className={cn(
              cardSurface,
              "relative w-full shrink-0 flex-col overflow-hidden p-4 md:w-64",
              managementCardPhone,
              managementListPaddingPhone,
              layer === "items" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            <div className="mb-3 flex h-10 items-center gap-2 px-3 max-md:pr-10 max-sm:pl-10 max-sm:pr-3">
              {/* 手機：項次清單的「‹」，與內容層的「‹」同一個位置（卡的左上角 8px）。DOM 在標題之前：開啟時的焦點落點。 */}
              {phone && layer === "items" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card", PHONE_BACK_LEFT, PANEL_CLOSE_HIT, PHONE_BACK_HIT)}
                  aria-label={canReturnToMenu ? t("management.backToMenu") : t("management.close")}
                  onClick={() => close(true)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
              <div className="min-w-0">
                <DialogTitle className="truncate text-[15px] font-semibold leading-tight tracking-normal">{title}</DialogTitle>
                {subtitle !== undefined && <p className="truncate text-xs font-normal text-muted-foreground">{subtitle}</p>}
              </div>
              {/* 窄寬度停在項次清單時右卡是 hidden，這裡補一顆 ✕，兩層都關得掉；位置與右卡的 ✕ 相同（卡的右上角 8px），兩層切換時不跳；只在這一層渲染，免得同時有兩顆同名的 Close。 */}
              {layer === "items" && !phone && (
                <DialogClose asChild>
                  <Button type="button" variant="ghost" size="icon" className={cn("absolute right-2 top-2 z-10 h-7 w-7 bg-card md:hidden", PANEL_CLOSE_HIT)} aria-label={t("management.close")}>
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DialogClose>
              )}
            </div>
            <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
            <nav ref={navRef} aria-label={title} className="flex flex-col gap-1">
              {items.map((item) => (
                <ManagementNavItem
                  key={item.to}
                  {...item}
                  backgroundLocation={backgroundLocation}
                  onSelect={() => switchTo("content")}
                />
              ))}
            </nav>
          </div>
          <div
            data-management-card="content"
            className={cn(
              cardSurface,
              "relative min-w-0 flex-1 flex-col overflow-hidden",
              managementCardPhone,
              managementCardPhoneInset,
              layer === "content" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            {/* 子節點順序是承重的：返回鈕 → ✕ → 內容容器（開啟焦點落點）。 */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card md:hidden", PHONE_BACK_LEFT, PANEL_CLOSE_HIT, PHONE_BACK_HIT)}
              aria-label={t("management.back")}
              onClick={() => switchTo("items")}
            >
              {phone ? <ChevronLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
            </Button>
            {/* 手機沒有 ✕：返回堆疊的「‹」一路退到項次清單、再退就關（見檔頭）。 */}
            {!phone && (
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("absolute right-2 top-2 z-10 h-7 w-7 bg-card", PANEL_CLOSE_HIT)}
                  aria-label={t("management.close")}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            )}
            <div
              ref={contentRef}
              data-management-content=""
              tabIndex={-1}
              className="flex-1 overflow-y-auto p-4 pt-12 focus:outline-none md:p-8"
            >
              {children}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
