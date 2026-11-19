import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface ManualCopyFieldProps {
  value: string;
}

/**
 * Fallback when both copy paths fail. A toast is not enough: Radix toast sets `userSelect: none` and swipe-to-dismiss eats horizontal drags. Must be mounted under a `<Dialog>` (`DialogDescription` reads the dialog context and throws outside).
 * Do not override the description `id`: `DialogContent`s `aria-describedby` points at Radix `descriptionId`, so overriding it dangles; the input is named with `aria-label` instead.
 * Auto-select deps are `[value]`, not an inline `ref` callback: a new callback identity each render would re-run `select()` and steal focus while typing.
 */
export function ManualCopyField({ value }: ManualCopyFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    inputRef.current?.select();
  }, [value]);

  return (
    <>
      <DialogDescription>{t("share.copyFailed")}</DialogDescription>
      <Input
        readOnly
        value={value}
        aria-label={t("share.copyFailed")}
        onFocus={(event) => event.currentTarget.select()}
        ref={inputRef}
      />
    </>
  );
}
