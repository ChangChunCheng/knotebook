import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import type { OutlineHeading } from "./headings";

/** How long after the last scroll the position bubble stays. */
export const OUTLINE_BUBBLE_HIDE_MS = 1500;

export interface OutlineScrollBubbleProps {
  headings: readonly OutlineHeading[];
  activeId: string | null;
  /** What scrolls: the window on a phone page, or the scroll container. */
  scrollTarget: HTMLElement | Window | null;
  /** `page`: fixed under the sticky page header. `anchor`: absolute inside a positioned anchor outside the scroller. */
  placement: "page" | "anchor";
  onOpen: () => void;
}

/**
 * Phone-only chip showing the current section while the page scrolls. It appears on scroll, leaves the tree
 * {@link OUTLINE_BUBBLE_HIDE_MS} after the last scroll, and is tap-only (no drag).
 */
export function OutlineScrollBubble({ headings, activeId, scrollTarget, placement, onOpen }: OutlineScrollBubbleProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const arm = useRef<() => void>(() => {});

  useEffect(() => {
    if (!scrollTarget) return;
    // While the chip has focus it stays mounted, so keyboard and screen-reader users keep a reachable button.
    const schedule = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (focused.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setVisible(false);
      }, OUTLINE_BUBBLE_HIDE_MS);
    };
    arm.current = schedule;
    const onScroll = () => {
      setVisible(true);
      schedule();
    };
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [scrollTarget]);

  if (!visible || headings.length === 0) return null;
  const found = activeId === null ? -1 : headings.findIndex((h) => h.id === activeId);
  const index = found === -1 ? 0 : found;
  const text = headings[index]!.text;
  const position = t("note.outline.position", {
    title: text === "" ? t("note.outline.untitled") : text,
    index: index + 1,
    total: headings.length,
  });

  return (
    <div
      className={cn(
        "z-30 flex h-9 max-w-[60vw] animate-in fade-in-0 duration-150",
        placement === "page"
          ? "fixed right-[max(0.5rem,env(safe-area-inset-right))] top-[calc(var(--kb-sticky-top,0px)+0.5rem)]"
          : "absolute right-2 top-2",
      )}
    >
      <button
        type="button"
        aria-label={t("note.outline.openAt", { position })}
        onClick={onOpen}
        // Tapping must not blur the editor: the mobile toolbar and keyboard state stay as they are.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => {
          focused.current = true;
          arm.current();
        }}
        onBlur={() => {
          focused.current = false;
          arm.current();
        }}
        className={cn(
          // The visible chip is 36px high; the pseudo-element stretches the tap area to 44px.
          "relative flex h-9 min-w-0 max-w-full items-center rounded-full px-3 text-xs text-foreground",
          "after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
          FROSTED_SURFACE,
        )}
      >
        <span className="truncate">{position}</span>
      </button>
    </div>
  );
}
