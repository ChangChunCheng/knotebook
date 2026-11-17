import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { OutlineHeading } from "./headings";

export interface OutlineListProps {
  headings: readonly OutlineHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Move focus to the current section's entry when the list mounts (keyboard open). */
  focusActiveOnMount?: boolean;
  className?: string;
}

const INDENT: Record<OutlineHeading["level"], string> = { 1: "pl-2", 2: "pl-5", 3: "pl-8" };

/** The heading entries as a list of buttons, indented by level, with arrow-key movement between entries. */
export function OutlineList({ headings, activeId, onSelect, focusActiveOnMount, className }: OutlineListProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const hasActive = activeId !== null && headings.some((h) => h.id === activeId);
  const fallbackId = hasActive ? activeId : (headings[0]?.id ?? null);
  // Roving tabindex: the entry that has focus; otherwise the current section, or the first entry.
  const tabId = focusedId !== null && headings.some((h) => h.id === focusedId) ? focusedId : fallbackId;

  useEffect(() => {
    if (focusActiveOnMount && tabId !== null) items.current.get(tabId)?.focus();
    // Only on mount: later `activeId` changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the current section changes while focus is elsewhere, the tab stop follows it again.
  useEffect(() => {
    if (!listRef.current?.contains(document.activeElement)) setFocusedId(null);
  }, [activeId]);

  useEffect(() => {
    if (activeId !== null) items.current.get(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const current = headings.findIndex((h) => items.current.get(h.id) === document.activeElement);
    if (current === -1) return;
    e.preventDefault();
    const next = Math.min(headings.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
    items.current.get(headings[next]!.id)?.focus();
  };

  const onFocus = (e: FocusEvent<HTMLOListElement>) => {
    const id = (e.target as HTMLElement).dataset.outlineItem;
    if (id) setFocusedId(id);
  };

  return (
    <ol ref={listRef} className={cn("m-0 list-none p-0", className)} onKeyDown={onKeyDown} onFocus={onFocus}>
      {headings.map((h) => {
        const active = h.id === activeId;
        const empty = h.text === "";
        return (
          <li key={h.id}>
            <button
              type="button"
              ref={(el) => {
                if (el) items.current.set(h.id, el);
                else items.current.delete(h.id);
              }}
              data-outline-item={h.id}
              tabIndex={h.id === tabId ? 0 : -1}
              aria-current={active ? "location" : undefined}
              title={empty ? t("note.outline.untitled") : h.text}
              onClick={(e) => {
                // Safari does not focus a button on click; focus it so focus stays on the entry.
                e.currentTarget.focus();
                onSelect(h.id);
              }}
              className={cn(
                // Rows look and react like the sidebar's note rows: brand tint on hover, a stronger one while pressed,
                // the browser's own focus ring for the keyboard.
                "block w-full rounded-md py-1 pr-2 pointer-coarse:py-2.5 text-left text-[13px] max-sm:text-[15px] hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
                INDENT[h.level],
                active ? "bg-brand-soft font-medium text-brand-on-soft hover:bg-brand-soft-strong" : "text-foreground",
              )}
            >
              <span className={cn("line-clamp-2 break-words", empty && "italic text-muted-foreground")}>
                {empty ? t("note.outline.untitled") : h.text}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
