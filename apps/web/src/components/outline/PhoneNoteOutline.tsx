import { useActiveHeading } from "./active-heading";
import type { OutlineHeading } from "./headings";
import { OutlineAnchor } from "./NoteOutline";
import { OutlineScrollBubble } from "./OutlineScrollBubble";
import { OutlineSheet } from "./OutlineSheet";
import { useOutlineJump } from "./use-outline-jump";

export interface PhoneNoteOutlineProps {
  headings: readonly OutlineHeading[];
  /** Where the headings are looked up and jumped to: the note's scroll container. */
  root: HTMLElement | null;
  /** What scrolls: the window on the note page (the document scrolls on a phone), the container on the public page. */
  scrollTarget: HTMLElement | Window | null;
  /** Viewport y of the visible top edge (under the sticky header on the note page). */
  topEdge: () => number;
  /** `page`: the bubble is fixed under the sticky header. `anchor`: it sits in a zero-height layer above the scroll container. */
  placement: "page" | "anchor";
  /** The editable area, if any: scrolls right after typing there do not show the bubble. */
  inputRoot?: HTMLElement | null;
  /** Pixels to keep clear below the bubble's track while the edit toolbar is not up (floating buttons, version history bubble). */
  bottomReserve?: number;
  /** `page` only: above 0 the edit toolbar is up and the track stops this far above the keyboard or colour panel. */
  editToolbarHeight?: number;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  /** The bubble was activated; gets the bubble as the place to return focus to when it had focus, otherwise `null`. */
  onOpenSheet: (returnFocusTo: HTMLElement | null) => void;
  /** Given to the sheet: where focus goes when it closes (picked or dismissed). */
  restoreFocus?: () => void;
}

/** Heading outline on a phone (#465): the position bubble while scrolling and the bottom sheet it opens. Nothing without headings. */
export function PhoneNoteOutline({
  headings,
  root,
  scrollTarget,
  topEdge,
  placement,
  inputRoot,
  bottomReserve,
  editToolbarHeight,
  sheetOpen,
  onSheetOpenChange,
  onOpenSheet,
  restoreFocus,
}: PhoneNoteOutlineProps) {
  const { activeId, markJumped } = useActiveHeading({ headings, root, scrollTarget, topEdge, enabled: headings.length > 0 });
  const onJump = useOutlineJump(root, markJumped);

  if (headings.length === 0) return null;

  const bubble = (
    <OutlineScrollBubble
      headings={headings}
      activeId={activeId}
      scrollTarget={scrollTarget}
      placement={placement}
      inputRoot={inputRoot}
      bottomReserve={bottomReserve}
      editToolbarHeight={editToolbarHeight}
      // While the sheet is up the bubble stays: it may be where focus returns when the sheet closes.
      hold={sheetOpen}
      onOpen={onOpenSheet}
    />
  );
  return (
    <>
      {placement === "anchor" ? <OutlineAnchor>{bubble}</OutlineAnchor> : bubble}
      <OutlineSheet
        open={sheetOpen}
        onOpenChange={onSheetOpenChange}
        headings={headings}
        activeId={activeId}
        onJump={onJump}
        restoreFocus={restoreFocus}
      />
    </>
  );
}
