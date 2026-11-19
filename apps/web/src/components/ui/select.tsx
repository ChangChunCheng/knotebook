import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "./icons";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  variant: "inline" | "field";
  id?: string;
  name?: string;
  form?: string;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  /** Width is the caller's: `w-full`, `w-fit` for content width (`shrink-0` only works inside a flex parent; the trigger is display:flex and fills a block/grid parent), or fixed like `w-28`. */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** Radix item values can't be an empty string; when an option really is `""` this string stands in on the way in and out. */
const EMPTY_SENTINEL = "__select_empty_value__";

const TRIGGER_BASE =
  "group min-w-0 items-center justify-between gap-2 text-left outline-none transition-colors " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TRIGGER_FIELD =
  "flex h-8 rounded-md border border-input bg-background px-3 py-1 text-sm pointer-coarse:text-base shadow-sm";

const TRIGGER_INLINE =
  "relative inline-flex h-8 max-w-full rounded-sm border-b border-dashed border-muted-foreground/85 bg-transparent px-0.5 text-sm pointer-coarse:text-base " +
  "pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']";

const CONTENT =
  "z-50 min-w-[max(8rem,var(--radix-select-trigger-width))] max-h-[var(--radix-select-content-available-height)] overflow-y-auto " +
  "rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md";

const SCROLL_BUTTON = "flex h-6 cursor-default items-center justify-center text-muted-foreground";

const ITEM =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm pointer-coarse:text-base outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export function Select({
  value,
  onValueChange,
  options,
  variant,
  id,
  name,
  form,
  disabled,
  placeholder,
  title,
  className,
  ...aria
}: SelectProps) {
  const hasEmptyOption = options.some((o) => o.value === "");
  const toRadix = (v: string) => (v === "" && hasEmptyOption ? EMPTY_SENTINEL : v);
  const fromRadix = (v: string) => (v === EMPTY_SENTINEL ? "" : v);
  const matched = options.find((o) => o.value === value);
  const radixValue = matched ? toRadix(value) : "";
  // For width: all option texts plus the placeholder (width doesn't change when the placeholder becomes a value).
  const sizerLabels = [...options.map((o) => o.label), ...(placeholder ? [placeholder] : [])];

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(v) => {
        // A real "" option goes through the sentinel; Radix reporting a raw "" only comes from the hidden native select syncing inside a form before options arrived, not from the user.
        if (v === "") return;
        onValueChange(fromRadix(v));
      }}
      disabled={disabled}
      name={name}
      form={form}
    >
      <SelectPrimitive.Trigger
        id={id}
        title={title}
        data-value={value}
        className={cn(TRIGGER_BASE, variant === "field" ? TRIGGER_FIELD : TRIGGER_INLINE, className)}
        {...aria}
      >
        {/* All option texts stacked in one hidden grid cell to reserve the longest width, so the trigger doesn't jump when the value changes; min-w-0 keeps them from affecting truncation at fixed/full width. */}
        <span className="grid min-w-0">
          <span className="min-w-0 truncate [grid-area:1/1]" data-select-text="">
            <SelectPrimitive.Value placeholder={placeholder ?? ""}>{matched?.label}</SelectPrimitive.Value>
          </span>
          {sizerLabels.map((label, i) => (
            <span
              key={i}
              aria-hidden="true"
              data-select-sizer=""
              className="invisible min-w-0 truncate [grid-area:1/1]"
            >
              {label}
            </span>
          ))}
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} collisionPadding={8} className={CONTENT}>
          <SelectPrimitive.ScrollUpButton className={SCROLL_BUTTON}>
            <ChevronDown aria-hidden="true" className="h-4 w-4 rotate-180" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={toRadix(o.value)} disabled={o.disabled} className={ITEM}>
                <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check aria-hidden="true" className="h-4 w-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className={SCROLL_BUTTON}>
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
