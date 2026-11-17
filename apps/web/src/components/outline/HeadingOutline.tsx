import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Pin, X } from "@/components/ui/icons";
import { useNoHover } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";
import type { OutlineHeading } from "./headings";
import { OutlineList } from "./OutlineList";
import { OUTLINE_PANEL_WIDTH, OUTLINE_RAIL_WIDTH, OUTLINE_TOP_OFFSET, type OutlinePlacement } from "./outline-layout";

export const OUTLINE_OPEN_DELAY_MS = 150;
export const OUTLINE_CLOSE_DELAY_MS = 250;

const LINE_LENGTH: Record<OutlineHeading["level"], number> = { 1: 20, 2: 14, 3: 8 };
const LINE_HEIGHT = 2;
const MIN_ROW = 4;
const MAX_ROW = 8;

export interface HeadingOutlineProps {
  headings: readonly OutlineHeading[];
  activeId: string | null;
  placement: OutlinePlacement;
  /** Tallest the rail or panel may be; the caller keeps it above the version bubble. */
  maxHeight: number;
  pinned: boolean;
  pinAvailable: boolean;
  onPinnedChange: (next: boolean) => void;
  onJump: (id: string) => void;
}

/**
 * A thin rail of one line per heading. Hover (mouse), tap (touch without hover) or Enter/Space on the rail opens
 * a floating panel with the heading texts; pinned, the panel stays open in place of the rail.
 * Positions are in the scroll container's coordinates: the caller places this in a zero-height layer outside the
 * scroll container whose top-left corner matches the container's (`OutlineAnchor`), so it does not scroll with the note.
 */
export function HeadingOutline({ headings, activeId, placement, maxHeight, pinned, pinAvailable, onPinnedChange, onJump }: HeadingOutlineProps) {
  const { t } = useTranslation();
  const noHover = useNoHover();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const panelOpen = pinned || open;

  const close = useCallback(() => {
    clearTimer();
    // Focus inside a panel that is about to unmount would drop to the page body; park it on the rail.
    if (panelRef.current?.contains(document.activeElement)) railRef.current?.focus();
    setOpen(false);
    setFocusOnOpen(false);
  }, [clearTimer]);

  // Pinning or unpinning replaces the floating state; do not carry a stale open panel across.
  const wasPinned = useRef(pinned);
  // Set when the reader pressed unpin, or while focus sits in the panel: only then does an unpin keep focus on the outline.
  // An automatic unpin (the window got narrower) with focus elsewhere must not pull focus in.
  const keepFocus = useRef(false);
  useEffect(() => {
    close();
    if (wasPinned.current && !pinned && keepFocus.current) railRef.current?.focus();
    if (!pinned) keepFocus.current = false;
    wasPinned.current = pinned;
  }, [pinned, close]);

  // A floating panel closes on a press outside the outline, whatever the pointer type.
  useEffect(() => {
    if (!open || pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, pinned, close]);

  const n = headings.length;
  const rowHeight = Math.min(MAX_ROW, Math.max(MIN_ROW, n === 0 ? MAX_ROW : Math.floor(maxHeight / n)));
  const scrolling = n * rowHeight > maxHeight;
  const railActiveRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (scrolling) railActiveRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [scrolling, activeId, headings]);

  const onPointerEnter = (e: ReactPointerEvent) => {
    if (pinned || noHover || e.pointerType !== "mouse") return;
    clearTimer();
    if (open) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, OUTLINE_OPEN_DELAY_MS);
  };
  const onPointerLeave = (e: ReactPointerEvent) => {
    if (pinned || noHover || e.pointerType !== "mouse") return;
    clearTimer();
    if (!open) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      close();
    }, OUTLINE_CLOSE_DELAY_MS);
  };

  const onRailClick = (e: MouseEvent) => {
    clearTimer();
    if (open) {
      // A mouse click while the hover panel is open keeps it open; touch and keyboard toggle.
      if (noHover || e.detail === 0) close();
      return;
    }
    setFocusOnOpen(e.detail === 0);
    setOpen(true);
  };

  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || pinned) return;
    e.stopPropagation();
    close();
    railRef.current?.focus();
  };

  // Focus moving out of the outline (Tab away) closes a floating panel; moving between its own parts does not.
  // A null target (clicking inert panel text, window blur) is left to the outside-press handler.
  const onBlur = (e: FocusEvent) => {
    if (pinned || !open) return;
    const next = e.relatedTarget;
    if (next instanceof Node && !wrapperRef.current?.contains(next)) close();
  };

  const select = (id: string) => {
    onJump(id);
    if (pinned) return;
    close();
  };

  const showClose = noHover && !pinned;
  const pinLabel = pinned ? t("note.outline.unpin") : t("note.outline.pin");

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-none absolute left-0 h-0 w-0"
      style={{ top: OUTLINE_TOP_OFFSET }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
    >
      {!pinned && (
        <button
          ref={railRef}
          type="button"
          data-testid="outline-rail"
          aria-label={t("note.outline.label")}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onRailClick}
          className={cn(
            "pointer-events-auto absolute flex flex-col items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            scrolling && "overflow-y-auto",
          )}
          style={{ top: 0, left: placement.railLeft, width: OUTLINE_RAIL_WIDTH, maxHeight }}
        >
          {headings.map((h) => {
            const active = h.id === activeId;
            return (
              <span
                key={h.id}
                ref={active ? railActiveRef : undefined}
                aria-hidden="true"
                data-level={h.level}
                data-active={active ? "" : undefined}
                className={cn("shrink-0 rounded-full", active ? "bg-brand" : "bg-muted-foreground/40")}
                style={{ width: LINE_LENGTH[h.level], height: LINE_HEIGHT, marginBlock: (rowHeight - LINE_HEIGHT) / 2 }}
              />
            );
          })}
        </button>
      )}
      {panelOpen && (
        <nav
          ref={panelRef}
          id={panelId}
          data-testid="outline-panel"
          aria-label={t("note.outline.label")}
          onKeyDown={onPanelKeyDown}
          onFocus={() => {
            keepFocus.current = true;
          }}
          onBlur={() => {
            keepFocus.current = false;
          }}
          className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
          style={{ top: 0, left: pinned ? placement.pinnedPanelLeft : placement.panelLeft, width: OUTLINE_PANEL_WIDTH, maxHeight }}
        >
          {(pinAvailable || pinned || showClose) && (
            <div className="flex shrink-0 justify-end gap-1 px-1 pt-1 pointer-coarse:gap-0">
              {(pinAvailable || pinned) && (
                <button
                  type="button"
                  aria-pressed={pinned}
                  aria-label={pinLabel}
                  title={pinLabel}
                  onClick={() => {
                    if (pinned) keepFocus.current = true;
                    onPinnedChange(!pinned);
                  }}
                  className={cn(
                    "inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    pinned && "bg-accent text-brand",
                  )}
                >
                  <Pin className="h-4 w-4" />
                </button>
              )}
              {showClose && (
                // The open panel covers the rail, so without hover a second tap on the rail would hit a heading.
                <button
                  type="button"
                  aria-label={t("note.outline.close")}
                  title={t("note.outline.close")}
                  onClick={() => {
                    close();
                    // Taps on iOS may not focus the button, so focus the rail explicitly.
                    railRef.current?.focus();
                  }}
                  className="inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <OutlineList
            headings={headings}
            activeId={activeId}
            onSelect={select}
            focusActiveOnMount={focusOnOpen}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          />
        </nav>
      )}
    </div>
  );
}
