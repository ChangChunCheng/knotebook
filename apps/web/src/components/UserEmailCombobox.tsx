import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import type { UserSuggestionDto } from "@knotebook/shared";
import { isSuggestQuery, useUserSuggestions } from "@/api/users";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 打字停多久才查（ms）。 */
export const SUGGEST_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface UserEmailComboboxProps {
  value: string;
  onChange: (email: string) => void;
  /** 可及名稱兼 placeholder。 */
  label: string;
  /** 已在名單上的人（成員、已分享對象）不再出現在建議裡。 */
  excludeUserIds?: ReadonlyArray<string>;
  className?: string;
}

/**
 * 加成員／分享對話框共用的 email 輸入框＋「認識的人」建議（`GET /api/users/suggest`，只含同群組成員與自己分享過的對象，
 * 不是全站名錄）。WAI-ARIA combobox（list autocomplete）：輸入框 `role="combobox"`、清單 `role="listbox"`，鍵盤 ↑／↓ 移動、
 * Enter 選取、Esc 收起；`aria-activedescendant` 指向目前那一項，焦點始終留在輸入框。
 *
 * 選取只是把 email 填進輸入框，不代為送出（角色下拉還要選）。沒有選中項目時 Enter 照常送出外層表單——打完整 email
 * 一樣能加，建議清單只是輔助。≥ 2 字、停 200 ms 才查；查詢失敗就當作沒有建議。
 *
 * 清單用 floating-ui 定位但**不 portal**：留在對話框的 DOM 裡，點選項不算 Radix Dialog 的「點外面」。
 * 高度 32px 的輸入框沿用 `ui/input`（`ui/button.tsx` 的同列等高規範）。
 */
export function UserEmailCombobox({ value, onChange, label, excludeUserIds, className }: UserEmailComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // open：使用者打過字之後才為真；選取、Esc、失焦、送出都收起。
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = useDebounced(value.trim(), SUGGEST_DEBOUNCE_MS);
  const suggestions = useUserSuggestions(query, open);

  const exclude = new Set(excludeUserIds ?? []);
  const items: UserSuggestionDto[] =
    open && isSuggestQuery(query) && isSuggestQuery(value.trim()) ? (suggestions.data ?? []).filter((u) => !exclude.has(u.userId)) : [];
  const expanded = items.length > 0;
  const activeIndex = active < items.length ? active : -1;

  const { refs, floatingStyles } = useFloating({
    open: expanded,
    placement: "bottom-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, availableHeight, elements }) {
          elements.floating.style.minWidth = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(280, availableHeight))}px`;
        },
      }),
    ],
  });

  // Esc 要先收起清單、不關掉外層 Radix Dialog：Radix 在 document 的 capture 階段聽 Escape，
  // 所以這裡在更早的 window capture 攔下（只在清單開著、且事件來自這個輸入框時）。
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape" || event.target !== inputRef.current) return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  function pick(user: UserSuggestionDto): void {
    onChange(user.email);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        return;
      }
      if (!expanded) return;
      event.preventDefault();
      setActive((i) => (i + 1 >= items.length ? 0 : i + 1));
    } else if (event.key === "ArrowUp") {
      if (!expanded) return;
      event.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      if (expanded && activeIndex >= 0) {
        // 選取，不送出表單
        event.preventDefault();
        pick(items[activeIndex]!);
      } else {
        setOpen(false);
        setActive(-1);
      }
    }
  }

  return (
    <div ref={refs.setReference} className={cn("relative", className)}>
      <Input
        ref={inputRef}
        type="email"
        required
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        placeholder={label}
        aria-label={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
      />
      {expanded && (
        <ul
          ref={refs.setFloating}
          id={listId}
          role="listbox"
          aria-label={t("userSuggest.listLabel")}
          style={floatingStyles}
          className="z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((user, index) => (
            <li
              key={user.userId}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown 預設會讓輸入框失焦（→ 收起清單、click 落空）：擋掉，焦點留在輸入框。
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(user)}
              onMouseMove={() => setActive(index)}
              className={cn(
                "flex min-w-0 cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              <span className="truncate font-medium">{user.displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
