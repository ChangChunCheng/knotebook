import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref,
  type SyntheticEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import { normalizeEmail, type UserSuggestionDto } from "@knotebook/shared";
import { isSuggestQuery, useUserSuggestions } from "@/api/users";
import { Avatar } from "@/components/Avatar";
import { Input } from "@/components/ui/input";
import { otherTokens, replaceToken, tokenAt } from "@/lib/email-list";
import { cn } from "@/lib/utils";

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
  label: string;
  placeholder?: string;
  excludeUserIds?: ReadonlyArray<string>;
  /** `type="text"` because native `type="email"` validation rejects multiple addresses; only the address under the caret is queried and replaced (separator rules shared with `parseEmailList`). */
  multiple?: boolean;
  readOnly?: boolean;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  "aria-describedby"?: string;
  ref?: Ref<HTMLInputElement>;
  className?: string;
}

/** Not portalled: the list stays in the dialog DOM so clicking an option is not a Radix Dialog "click outside". */
export function UserEmailCombobox({
  value, onChange, label, placeholder, excludeUserIds, multiple = false, readOnly = false, onPaste,
  "aria-describedby": describedBy, ref, className,
}: UserEmailComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [caret, setCaret] = useState(0);
  const pendingCaretRef = useRef<number | null>(null);
  if (readOnly && open) {
    setOpen(false);
    setActive(-1);
  }

  const span = multiple ? tokenAt(value, caret) : null;
  const liveQuery = span ? span.token : value.trim();
  const query = useDebounced(liveQuery, SUGGEST_DEBOUNCE_MS);
  const suggestions = useUserSuggestions(query, open);

  const exclude = new Set(excludeUserIds ?? []);
  const typed = span ? new Set(otherTokens(value, span.start, span.end).map(normalizeEmail)) : null;
  const items: UserSuggestionDto[] =
    open && isSuggestQuery(query) && isSuggestQuery(liveQuery)
      ? (suggestions.data ?? []).filter((u) => !exclude.has(u.userId) && !typed?.has(normalizeEmail(u.email)))
      : [];
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

  // Esc must close the list before the outer Radix Dialog: Radix listens in the document capture phase, so intercept earlier in window capture.
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

  // Place the caret only after the outer state writes the new value back.
  useLayoutEffect(() => {
    const next = pendingCaretRef.current;
    const input = inputRef.current;
    if (next === null || !input || input.value !== value) return;
    pendingCaretRef.current = null;
    input.setSelectionRange(next, next);
  }, [value]);

  function pick(user: UserSuggestionDto): void {
    if (readOnly) return;
    if (span) {
      const replaced = replaceToken(value, span.start, span.end, user.email);
      setCaret(replaced.caret);
      if (replaced.text === value) {
        // Value unchanged: outer state will not re-render, so place the caret directly.
        inputRef.current?.setSelectionRange(replaced.caret, replaced.caret);
      } else {
        pendingCaretRef.current = replaced.caret;
        onChange(replaced.text);
      }
    } else {
      onChange(user.email);
    }
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  // Caret moved to another address: close the stale suggestions, otherwise picking would replace the wrong address.
  function handleSelect(event: SyntheticEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const next = input.selectionStart ?? input.value.length;
    if (tokenAt(input.value, next).start !== tokenAt(input.value, caret).start) {
      setOpen(false);
      setActive(-1);
    }
    setCaret(next);
  }

  /** Paste (#331) changes the value outside onChange, so close the list here too. */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    onPaste?.(event);
    if (event.defaultPrevented) {
      setOpen(false);
      setActive(-1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // IME composition keys belong to the IME.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      if (!open) {
        if (!readOnly) setOpen(true);
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
        ref={setInputRef}
        type={multiple ? "text" : "email"}
        inputMode={multiple ? "email" : undefined}
        required
        readOnly={readOnly}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder ?? label}
        aria-label={label}
        value={value}
        onChange={(event) => {
          pendingCaretRef.current = null;
          onChange(event.target.value);
          if (multiple) setCaret(event.target.selectionStart ?? event.target.value.length);
          setOpen(true);
          setActive(-1);
        }}
        onSelect={multiple ? handleSelect : undefined}
        onPaste={handlePaste}
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
              // mousedown would blur the input and close the list before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(user)}
              onMouseMove={() => setActive(index)}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              <Avatar name={user.displayName} avatar={user.avatar ?? null} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{user.displayName}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
