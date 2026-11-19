import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ChangeEvent, type InputHTMLAttributes } from "react";
import type { SelectAllState } from "@/lib/sidebar-selection";
import { cn } from "@/lib/utils";
import { Check, Minus } from "./icons";

/** Still a native `<input type="checkbox">` (`appearance-none`): Shift range reads the native click's `shiftKey`, `<label>` forwards clicks, keyboard and `getByRole("checkbox")` are unchanged; the tick and dash are an svg on top. Reference only via the `SelectLazy`/`TrashLazy` chain (not in the first bundle). */
export interface SelectionCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> {
  /** When true, input `checked` is always false (indeterminate wins). */
  indeterminate?: boolean;
  className?: string;
}

export const SelectionCheckbox = forwardRef<HTMLInputElement, SelectionCheckboxProps>(function SelectionCheckbox(
  { indeterminate = false, className, checked, onChange, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  // `indeterminate` can only be set from JS. No deps: rewritten on every commit, so a state the browser cleared on click is restored.
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    // The browser clears indeterminate on click; if the parent doesn't change state there is no re-render, so write the current prop back here.
    event.currentTarget.indeterminate = indeterminate;
  };
  return (
    <span className={cn("relative inline-flex h-3.5 w-3.5 shrink-0", className)}>
      <input
        {...rest}
        ref={inputRef}
        type="checkbox"
        checked={indeterminate ? false : checked}
        onChange={handleChange}
        className="peer h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-sm border border-muted-foreground bg-transparent checked:border-brand checked:bg-brand indeterminate:border-brand indeterminate:bg-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Check aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden h-2.5 w-2.5 text-brand-fg peer-checked:block peer-disabled:opacity-50" />
      <Minus aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden h-2.5 w-2.5 text-brand-fg peer-indeterminate:block peer-disabled:opacity-50" />
    </span>
  );
});

export function SelectAllCheckbox({
  state,
  disabled,
  onToggle,
  label,
  title,
}: {
  state: SelectAllState;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
  title: string;
}) {
  // The outer 24px carries the same title: hovering beside the 14px box (inside this cell) also shows the hint.
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center" title={title}>
      <SelectionCheckbox
        checked={state === "all"}
        indeterminate={state === "some"}
        disabled={disabled}
        aria-label={label}
        title={title}
        onChange={onToggle}
      />
    </span>
  );
}
