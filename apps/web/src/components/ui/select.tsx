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
  /** `inline`：表格列內或句子中，只有底線；`field`：獨立的表單欄位，外框同 `Input`。 */
  variant: "inline" | "field";
  /** 給 `<label htmlFor>` 指到觸發鈕。 */
  id?: string;
  /** 有給才參與表單送出。 */
  name?: string;
  form?: string;
  disabled?: boolean;
  /** `value` 不在 `options` 時顯示。 */
  placeholder?: string;
  title?: string;
  /** 寬度由呼叫端決定：`w-full`、內容寬用 `w-fit`（`shrink-0` 只在 flex 父層內有效，觸發鈕是 display:flex，在 block／grid 父層會撐滿）、或固定寬度如 `w-28`。 */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** Radix 的項目值不能是空字串；選項裡真有 `""` 時，進出 Radix 用這個字串代替。 */
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
  // 值不在選項裡（含空字串但沒有空字串選項）：交給 Radix 顯示 placeholder。
  const radixValue = matched ? toRadix(value) : "";
  // 撐寬用：全部選項文字，加上 placeholder（從 placeholder 換成值時寬度也不變）。
  const sizerLabels = [...options.map((o) => o.label), ...(placeholder ? [placeholder] : [])];

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(v) => {
        // 真正的 "" 選項走 sentinel，Radix 回報原始 "" 只會來自表單內隱藏原生 select 同步時選項還沒到齊，不是使用者選的。
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
        {/* 所有選項文字疊在同一格（隱藏）撐出最長的寬度，換值時觸發鈕寬度不跳；
            固定／滿版寬度下 min-w-0 讓它們不影響截斷。 */}
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
