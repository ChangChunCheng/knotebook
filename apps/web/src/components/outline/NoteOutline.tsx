import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useActiveHeading } from "./active-heading";
import type { OutlineHeading } from "./headings";
import { HeadingOutline } from "./HeadingOutline";
import { jumpToHeading } from "./outline-jump";
import { outlineMaxHeight, outlinePlacement } from "./outline-layout";
import type { OutlineBox } from "./use-outline-box";

/**
 * Zero-height positioning layer for the outline, rendered right above the scroll container (a sibling, not inside it),
 * so the rail and the panel stay put while the note scrolls and take no layout space. Its top edge is the scroll
 * container's top edge and its left edge the container's left edge, which is what the outline's coordinates assume.
 * `z-20` keeps it over the note text and under dialogs (`z-50`). The layer itself lets the pointer through;
 * only the rail and the panel take it.
 */
export function OutlineAnchor({ children }: { children: ReactNode }) {
  return (
    <div data-outline-anchor="" className="pointer-events-none relative z-20 h-0 shrink-0">
      {children}
    </div>
  );
}

export interface NoteOutlineProps {
  headings: readonly OutlineHeading[];
  /** The note's scroll container: headings are looked up and scrolled inside it. */
  scrollEl: HTMLElement | null;
  box: OutlineBox;
  /** The version bubble sits in the bottom-right corner; the outline stops above it. */
  bubbleShown: boolean;
  pinned: boolean;
  pinAvailable: boolean;
  onPinnedChange: (next: boolean) => void;
}

/** Heading outline of a note page (desktop and tablet): rail and panel wired to the scroll container. Nothing without headings. */
export function NoteOutline({ headings, scrollEl, box, bubbleShown, pinned, pinAvailable, onPinnedChange }: NoteOutlineProps) {
  const topEdge = useCallback(() => scrollEl?.getBoundingClientRect().top ?? 0, [scrollEl]);
  const { activeId, markJumped } = useActiveHeading({ headings, root: scrollEl, scrollTarget: scrollEl, topEdge, enabled: true });

  // One jump at a time: a new click cancels the previous one's pending wait and flash.
  const cancelJump = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelJump.current?.();
      cancelJump.current = null;
    },
    [],
  );
  const onJump = useCallback(
    (id: string) => {
      if (!scrollEl) return;
      cancelJump.current?.();
      cancelJump.current = jumpToHeading(scrollEl, id);
      markJumped(id);
    },
    [scrollEl, markJumped],
  );

  if (headings.length === 0) return null;

  return (
    <OutlineAnchor>
      <HeadingOutline
        headings={headings}
        activeId={activeId}
        placement={outlinePlacement(box.width, box.columnRight)}
        maxHeight={outlineMaxHeight(box.height, bubbleShown)}
        pinned={pinned}
        pinAvailable={pinAvailable}
        onPinnedChange={onPinnedChange}
        onJump={onJump}
      />
    </OutlineAnchor>
  );
}
