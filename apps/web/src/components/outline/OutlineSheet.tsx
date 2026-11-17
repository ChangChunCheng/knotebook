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
  /** Called when the sheet closed after a pick, before the jump (e.g. return focus to the editor without scrolling). */
  restoreFocus?: () => void;
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
          if (id === null) return;
          // Without a custom restore, Radix returns focus to the element that opened the sheet.
          if (restoreFocus) {
            e.preventDefault();
            restoreFocus();
          }
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
