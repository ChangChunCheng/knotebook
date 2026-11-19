import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * mousedown preventDefault keeps the editor focused and the on-screen keyboard up. Only mousedown, not pointerdown: on WebKit a prevented pointerdown suppresses click.
 * Disabled uses `aria-disabled` + early return in click, not native `disabled`: Chromium touch on a `disabled` button sends no mousedown,
 * so the default isn't prevented and the editor blurs.
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
