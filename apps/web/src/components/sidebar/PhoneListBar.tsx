import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "@/components/ui/icons";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { cn } from "@/lib/utils";
import { PHONE_BAR_FRAME, phoneBarBottomPadding } from "./phone-bar";

interface PhoneListBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Sticky at the window bottom. With the keyboard open, `bottom` (keyboard height, from the visual viewport difference) lifts it above the keyboard and an equal `marginBottom` lets the last results scroll above it.
 * Search field is 16px so iOS doesn't zoom on focus. The keyboard covers the bottom safe area, so that padding is dropped then.
 */
export function PhoneListBar({ query, onQueryChange, searchRef, onOpen, onClose }: PhoneListBarProps) {
  const { t } = useTranslation();
  const inset = useKeyboardInset();
  const keyboardOpen = isKeyboardOpen(inset);
  return (
    <div
      data-phone-list-bar=""
      style={keyboardOpen ? { bottom: inset, marginBottom: inset } : undefined}
      className={cn("flex items-center gap-2", PHONE_BAR_FRAME, phoneBarBottomPadding(keyboardOpen))}
    >
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={onOpen}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            onQueryChange("");
            event.currentTarget.blur();
            onClose();
          }}
          aria-label={t("sidebar.searchLabel")}
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-11 pl-9 text-base"
        />
      </div>
      {keyboardOpen ? null : (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 px-3"
          onClick={() => {
            onQueryChange("");
            searchRef.current?.blur();
            onClose();
          }}
        >
          {t("home.cancel")}
        </Button>
      )}
    </div>
  );
}
