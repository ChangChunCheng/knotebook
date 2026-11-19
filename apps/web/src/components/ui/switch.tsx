import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * For settings that take effect immediately; use `Checkbox` for form fields applied on submit. Exceptions that apply on submit: the create-token dialog's edit/move switches (shared `settings/ScopeTogglesField.tsx` with inline editing, so one control set doesn't look different in two places);
 * the site trash "auto purge" switch (applies on "Save": an immediate send with the default 7 days could purge a batch of old trash within an hour); the new-role dialog's six permission flags (shared `FlagSwitchRow` with the role cards).
 * The accessible role is `role="switch"`, not `checkbox`: tests using `getByRole("checkbox", …)` must use `"switch"`.
 * Deliberately much smaller than button.tsx's 32px controls; the click target is the Radix `<button>` itself. `tone="destructive"` turns the on state `bg-destructive` (the token "move" permission: irreversible consequences).
 */
export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { tone?: "default" | "destructive" }
>(({ className, tone = "default", ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-3.5 w-[26px] shrink-0 cursor-pointer items-center rounded-full border border-transparent " +
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        "data-[state=checked]:bg-brand data-[state=unchecked]:bg-input",
      tone === "destructive" && "data-[state=checked]:bg-destructive",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-2.5 w-2.5 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
