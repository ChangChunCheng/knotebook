import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "./icons";
import { cn } from "@/lib/utils";

/**
 * For form fields applied on submit; use `Switch` for immediate settings. The role is `checkbox` but it is a `<button>`, not an `<input>`: tests must use `fireEvent.click`, not `fireEvent.change` with `target.checked`.
 * The click target is enlarged by the surrounding layout, not by the box itself.
 */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-input bg-background shadow-sm transition-colors " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-fg",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
