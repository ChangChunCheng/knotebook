import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 手機編輯工具列的按鈕：44×44、圖示置中。mousedown 時 preventDefault，編輯器不失焦、螢幕鍵盤不收。
 * 只擋 mousedown、不擋 pointerdown：WebKit 上 pointerdown 被擋就不會發 click。
 * 傳 `pressed` 時是切換鈕（`aria-pressed`＋底色）。
 * 停用用 `aria-disabled`＋點擊早退，不用原生 `disabled`：Chromium 觸控點到 `disabled` 的按鈕時 mousedown 不會送出，
 * 預設動作不被擋，編輯器會失焦。
 */
export function MobileToolbarButton({
  label,
  onClick,
  children,
  pressed,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onMouseDown={(event: MouseEvent) => event.preventDefault()}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-full text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "opacity-40",
        pressed ? "bg-accent text-accent-foreground" : "active:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
