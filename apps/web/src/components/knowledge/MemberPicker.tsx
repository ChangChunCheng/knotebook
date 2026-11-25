import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useKnowledgeMemberNames } from "@/api/knowledge-members";
import { isSuggestQuery, useUserSuggestions } from "@/api/users";
import { useSession } from "@/auth/useSession";
import { Input } from "@/components/ui/input";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface MemberPickerProps {
  id: string;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  /** A user id, or "". */
  value: string;
  noteId: string | null;
  onChange: (userId: string) => void;
}

const SUGGEST_DEBOUNCE_MS = 200;

interface Row {
  userId: string;
  name: string;
  detail: string | null;
}

/** The list is part of the form's layout, not a portal: inside a popover or a modal dialog a portalled list would count as an outside press. */
export function MemberPicker({ id, labelledBy, describedBy, invalid, value, noteId, onChange }: MemberPickerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const { user } = useSession();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setActive] = useState(0);
  // Someone just picked from the suggestions isn't stored yet, so the stored-member lookup can't name them.
  const [picked, setPicked] = useState<{ userId: string; name: string } | null>(null);
  const names = useKnowledgeMemberNames(noteId, value === "" ? [] : [value]);

  const trimmed = query.trim();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(trimmed), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const suggestions = useUserSuggestions(debounced, open);

  const rows: Row[] = [];
  if (user) rows.push({ userId: user.id, name: t("knowledge.member.me"), detail: null });
  if (isSuggestQuery(trimmed) && isSuggestQuery(debounced)) {
    for (const s of suggestions.data ?? []) if (s.userId !== user?.id) rows.push({ userId: s.userId, name: s.displayName, detail: s.email });
  }
  const active = Math.min(highlighted, Math.max(rows.length - 1, 0));

  const nameOf = (userId: string): string => {
    if (picked?.userId === userId) return picked.name;
    if (user?.id === userId) return user.displayName;
    const found = names.get(userId);
    if (found) return found.displayName;
    return names.answered ? t("knowledge.member.unknown") : "";
  };
  const shown = value === "" ? "" : nameOf(value);

  const choose = (row: Row) => {
    setPicked({ userId: row.userId, name: row.userId === user?.id ? user.displayName : row.name });
    onChange(row.userId);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An Enter that confirms an input-method composition must not pick a row.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive(Math.min(active + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (event.key === "Enter" && open) {
      // Also keeps the form's own Enter-to-save from firing while a row is being picked.
      event.preventDefault();
      event.stopPropagation();
      const row = rows[active];
      if (row) choose(row);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className="relative" data-kb-member-picker="">
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          className={cn(value !== "" && "pr-8")}
          value={open ? query : shown}
          placeholder={shown || t("knowledge.member.placeholder")}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={(e) => {
            if (!e.currentTarget.closest("[data-kb-member-picker]")?.contains(e.relatedTarget as Node | null)) {
              setOpen(false);
              setQuery("");
            }
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {value !== "" && (
          <button
            type="button"
            aria-label={t("knowledge.member.clear")}
            onClick={() => {
              setPicked(null);
              onChange("");
            }}
            className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <ul id={listId} role="listbox" aria-labelledby={labelledBy} className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-sm">
          {rows.map((row, i) => (
            <li
              key={row.userId}
              id={optionId(i)}
              role="option"
              aria-selected={row.userId === value}
              // mousedown, not click: the input's blur would close the list before a click lands.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(row);
              }}
              onMouseMove={() => setActive(i)}
              className={cn("cursor-default rounded-sm px-2 py-1.5 text-sm pointer-coarse:py-2.5", i === active && "bg-accent text-accent-foreground")}
            >
              <span className="block truncate font-medium">{row.name}</span>
              {row.detail && <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
