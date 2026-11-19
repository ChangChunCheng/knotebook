import { forwardRef, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import { ROW_ICON_BUTTON, ROW_ICON_DANGER } from "@/components/management/row-actions";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type ButtonProps = ComponentPropsWithoutRef<typeof Button>;

export type RowIconButtonProps = Omit<ButtonProps, "variant" | "size" | "children" | "aria-label" | "title" | "asChild" | "aria-disabled"> & {
  label: string;
  icon: ReactNode;
  tone?: "default" | "destructive";
  /**
   * Not usable but the reason must stay visible (e.g. the last admin can't be removed): `aria-disabled` + `title` set to `softDisabledReason`, click does nothing. Not native `disabled`: `disabled:pointer-events-none` would stop `title` ever showing.
   * For `DialogTrigger asChild`, `handleClick` blocks opening two ways: not forwarding the injected `onClick`, or `preventDefault()` (Radix's `composeEventHandlers` skips `onOpenToggle` on `defaultPrevented`); `preventDefault()` also stops `type="submit"` form submission, while a plain `onClick` relies on not forwarding.
   * Only click is intercepted: `onPointerDown`/`onKeyDown` still forward, so unsuitable as a `DropdownMenuTrigger`.
   */
  softDisabled?: boolean;
  softDisabledReason?: string;
};

export const RowIconButton = forwardRef<HTMLButtonElement, RowIconButtonProps>(
  ({ label, icon, tone = "default", softDisabled = false, softDisabledReason, className, onClick, ...props }, ref) => {
    function handleClick(event: MouseEvent<HTMLButtonElement>): void {
      if (softDisabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    }
    return (
      <Button
        ref={ref}
        type="button"
        {...props}
        variant="ghost"
        size="icon"
        aria-label={label}
        title={softDisabled && softDisabledReason !== undefined ? softDisabledReason : label}
        aria-disabled={softDisabled || undefined}
        className={cn(
          "shrink-0",
          tone === "destructive" ? ROW_ICON_DANGER : cn(ROW_ICON_BUTTON, "aria-disabled:opacity-40"),
          softDisabled && "cursor-not-allowed",
          className,
        )}
        onClick={handleClick}
      >
        {icon}
      </Button>
    );
  },
);
RowIconButton.displayName = "RowIconButton";
