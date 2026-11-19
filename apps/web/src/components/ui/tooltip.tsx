import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** Thin Radix Tooltip wrapper (#293). Callers pass `aria-describedby={undefined}` on the Trigger: Radix 1.2.16 sets `aria-describedby` before spreading props (`react-tooltip dist/index.mjs:186-188`), and the caller's `aria-label` already carries everything, so without the override it is read twice. */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
