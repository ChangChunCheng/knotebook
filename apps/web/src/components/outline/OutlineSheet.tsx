import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OutlineHeading } from "./headings";
import { OutlineList } from "./OutlineList";

export interface OutlineSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headings: readonly OutlineHeading[];
  activeId: string | null;
  onJump: (id: string) => void;
  /**
   * Where focus goes when the sheet closes, picked or dismissed (e.g. back to the editor without scrolling); after a pick it runs
   * before the jump. Without it focus is left on the page body: the sheet has no trigger for the dialog to return to.
   */
  restoreFocus?: () => void;
}

/** A {@link OutlineSheetProps.restoreFocus} that focuses `el` without scrolling, if it is still in the page; `undefined` without an element. */
export function focusBackTo(el: HTMLElement | null | undefined): (() => void) | undefined {
  if (!el) return undefined;
  return () => {
    if (el.isConnected) el.focus({ preventScroll: true });
  };
}

/** Phone bottom sheet listing the headings; the current section is highlighted and focused on open. */
export function OutlineSheet({ open, onOpenChange, headings, activeId, onJump, restoreFocus }: OutlineSheetProps) {
  const { t } = useTranslation();
  const picked = useRef<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Radix reports only dismissals (Escape, backdrop, close button); a pick goes through `onSelect`.
        picked.current = null;
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          const id = picked.current;
          picked.current = null;
          // Any close, picked or dismissed: with no trigger the dialog would leave focus on the body (on a phone that also
          // drops the editing toolbar), so the caller decides where focus goes.
          if (restoreFocus) {
            e.preventDefault();
            restoreFocus();
          }
          if (id === null) return;
          // The scroll lock is released only after the sheet is gone; jumping while it holds scrolls nothing.
          requestAnimationFrame(() => onJump(id));
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("note.outline.label")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60dvh] overflow-y-auto">
          <OutlineList
            headings={headings}
            activeId={activeId}
            focusActiveOnMount
            onSelect={(id) => {
              picked.current = id;
              onOpenChange(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
