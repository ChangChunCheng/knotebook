import { forwardRef, useCallback, useEffect, useRef, type ComponentPropsWithoutRef, type ElementRef, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "./icons";
import { cn } from "@/lib/utils";
import { readKeyboardInset } from "@/lib/visual-viewport";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out " +
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** `size="default"`＝既有的單欄表單 dialog 尺寸（NoteList/ShareDialog 既有用法，
 * 未傳 `size` 時行為零變）；`lg` 已於 #247 刪除：再用會直接型別錯誤，比照 `button.tsx` 刪 `secondary`
 * 的做法，不靠 grep 測試；`size="panel"`＝三個管理面板（`components/management/ManagementShell.tsx`，#247）
 * 與快捷鍵介紹頁（`components/shortcuts/ShortcutsDialog.tsx`，單卡、寬度另以 className 收窄）：
 * 外框本身透明無邊、不投影，托盤與兩張卡由 ManagementShell 自己畫；640～767 為 `96vw × 92dvh`，手機（< 640）是滿版整頁（`inset-0 h-dvh`），
 * `md:` 以上 `92vw × 88dvh` 夾在 896×672～1360×896 之間（高度一律用 `dvh`：iOS Safari 的 `vh` 比看得見的高度高）；`max-w` 讓兩側各至少留 2vw 與左右 safe area 的較大者（橫拿時面板邊緣不進感應器區）。`panel` 時**不渲染內建 Close**——
 * 面板在右卡自己放一顆帶 i18n 名稱的 ✕，這裡再放就會有兩顆 Close。
 * `panel` 的 grid 軌道是 `minmax(0,1fr)`：預設的 `auto` 軌道會依托盤內容撐大，托盤就會在高度與寬度上都長出外框、右卡永遠不捲動。 */
const dialogContentVariants = cva(
  "fixed left-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 outline-none " +
    "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg duration-200 " +
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 " +
    "data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
  {
    variants: {
      size: {
        default:
          "max-w-lg p-6 " +
          // 手機（< 640）：貼底的 sheet。鍵盤升起時 `--kb-inset` 把 sheet 抬到鍵盤上方、`--kb-visible-h`（視覺視窗高）決定高度上限，
          // 這樣 iOS 平移視覺視窗時 sheet 的頂端也不會跑出可見範圍；內容高過上限就在 sheet 內捲動。
          // 不過場：bottom／max-height 若跟著 `duration-200` 過渡，sheet 會落後鍵盤並在平移時晃動。
          "max-sm:inset-x-0 max-sm:bottom-(--kb-inset,0px) max-sm:top-auto max-sm:translate-x-0 max-sm:translate-y-0 " +
          "max-sm:max-w-none max-sm:max-h-[calc(var(--kb-visible-h,100dvh)*0.9)] max-sm:overflow-y-auto max-sm:transition-none " +
          "max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] kb-sheet",
        panel:
          "p-0 bg-transparent border-0 shadow-none overflow-visible w-[96vw] h-[92dvh] " +
          "max-w-[calc(100vw-2*max(2vw,env(safe-area-inset-left),env(safe-area-inset-right)))] " +
          "grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] " +
          // 手機（< 640）：整頁。`dvh` 跟著 iOS Safari 看得見的高度（`vh` 用的是工具列收起時的高度，置中後頂端會跑出畫面）；
          // 上下 safe area 由托盤的內距給（`management/tray.ts`）。
          "max-sm:inset-0 max-sm:h-dvh max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none " +
          "md:w-[clamp(min(56rem,96vw),92vw,85rem)] md:h-[clamp(min(42rem,92dvh),88dvh,56rem)]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * 手機 sheet 跟著螢幕鍵盤：只在對話框開著（內容有掛載）時訂閱 `visualViewport`，直接把 `--kb-inset`（鍵盤高）與
 * `--kb-visible-h`（視覺視窗高）寫到內容元素上，不觸發 React 重繪；沒有視覺視窗或雙指放大中時兩個變數都移除。
 * 同一幀的多次事件合併成一次讀值。
 */
function SheetViewportVars({ target }: { target: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const element = target.current;
      if (!element) return;
      // 以縮放判斷而不是以鍵盤高度：iOS 把視覺視窗平移到底時鍵盤高度剛好是 0，但可見高度仍比版面視窗矮。
      if (Math.abs(viewport.scale - 1) <= 0.01) {
        element.style.setProperty("--kb-inset", `${readKeyboardInset()}px`);
        element.style.setProperty("--kb-visible-h", `${viewport.height}px`);
      } else {
        element.style.removeProperty("--kb-inset");
        element.style.removeProperty("--kb-visible-h");
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [target]);
  return null;
}

/**
 * `dismissOnOutside`（預設 `true`＝Radix 預設行為，零變）：設為 `false` 時，**只**擋「點對話框外面」
 * （Radix `onInteractOutside`＝pointerDownOutside＋focusOutside，含焦點移出）。Esc、右上 X、
 * 取消鈕照常關閉。
 *
 * 表單型對話框（有使用者可輸入的欄位、由此對話框送出）一律傳 `false`：誤點周圍就丟掉已填內容。
 * 刻意不做「有填過才擋」的 dirty 判斷——各表單的 dirty 條件（預設值、trim、select 回到初值…）
 * 很容易判錯，一律擋最簡單也最不會漏。純確認型／唯讀型對話框維持預設。
 *
 * 呼叫端自己傳的 `onInteractOutside` 會先被呼叫，再套這個守衛（不吞呼叫端 handler）；
 * 呼叫端另傳的 `onPointerDownOutside`／`onFocusOutside` 由 Radix 先於 `onInteractOutside` 觸發，不受影響。
 */
export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof dialogContentVariants> & { dismissOnOutside?: boolean }
>(({ className, children, size, dismissOnOutside = true, onInteractOutside, style, ...props }, ref) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // #247：panel 由 ManagementShell 在右卡放自己的 ✕；這裡只決定要不要渲染，不新增 prop。
  const renderBuiltInClose = size !== "panel";
  return (
    <DialogPortal>
      <DialogOverlay className={size === "panel" ? undefined : "kb-sheet-overlay"} />
      <DialogPrimitive.Content
        ref={setRefs}
        style={style}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!dismissOnOutside) event.preventDefault();
        }}
      >
        {renderBuiltInClose && <SheetViewportVars target={contentRef} />}
        {children}
        {renderBuiltInClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-[''] opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
