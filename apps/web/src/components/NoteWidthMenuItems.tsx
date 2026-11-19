import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NOTE_WIDTHS } from "@knotebook/shared";
import { useWidePointer } from "@/lib/wide-pointer";
import { toNoteWidth, useNoteWidth } from "@/components/note-width";
import {
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown } from "@/components/ui/icons";
import { NoteWidthIcon } from "@/components/ui/icons-extra";

export interface NoteWidthItemsControl {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onModeChange: () => void;
}

const WIDTH_RADIO_ROW =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";

/** Two forms (same criterion as `GroupTransferMenuItems`): nested submenu when wide and hoverable; in-place radios when narrow or touch, with the expanded state owned by `NoteMenu` so Esc collapses first. */
export function NoteWidthMenuItems({ noteId, expanded, onExpandedChange, onModeChange }: NoteWidthItemsControl & { noteId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useNoteWidth(noteId);
  const wide = useWidePointer();
  const prevWide = useRef(wide);
  useEffect(() => {
    if (prevWide.current === wide) return;
    prevWide.current = wide;
    onModeChange();
  }, [wide, onModeChange]);
  const [subOpen, setSubOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  // After an in-place collapse focus was on an unmounted radio: return it to the Width item.
  const prevExpanded = useRef(expanded);
  useEffect(() => {
    const prev = prevExpanded.current;
    prevExpanded.current = expanded;
    if (prev && !expanded && !document.activeElement?.closest('[role="menuitem"]')) triggerRef.current?.focus();
  }, [expanded]);
  const label = t("note.width.label");
  const radios = NOTE_WIDTHS.map((w) => (
    <DropdownMenuRadioItem
      key={w}
      value={w}
      className={WIDTH_RADIO_ROW}
      onSelect={wide ? undefined : (event) => event.preventDefault()}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuItemIndicator>
      </span>
      {t(`note.width.${w}`)}
    </DropdownMenuRadioItem>
  ));
  if (wide) {
    return (
      <DropdownMenuSub open={subOpen} onOpenChange={setSubOpen}>
        <DropdownMenuSubTrigger ref={triggerRef}>
          <NoteWidthIcon width={width} className="mr-2 h-4 w-4" />
          {label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setSubOpen(false);
            triggerRef.current?.focus();
          }}
        >
          <DropdownMenuRadioGroup value={width} onValueChange={(v) => setWidth(toNoteWidth(v))}>
            {radios}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        aria-expanded={expanded}
        // Keep the menu open; only toggle expansion.
        onSelect={(event) => {
          event.preventDefault();
          onExpandedChange(!expanded);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !expanded) {
            event.preventDefault();
            onExpandedChange(true);
          } else if (event.key === "ArrowLeft" && expanded) {
            event.preventDefault();
            onExpandedChange(false);
          }
        }}
      >
        <NoteWidthIcon width={width} className="mr-2 h-4 w-4" />
        {label}
        <ChevronDown className={"ml-auto h-4 w-4 transition-transform" + (expanded ? " rotate-180" : "")} />
      </DropdownMenuItem>
      {expanded && (
        <DropdownMenuRadioGroup
          aria-label={label}
          value={width}
          onValueChange={(v) => setWidth(toNoteWidth(v))}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onExpandedChange(false);
            }
          }}
        >
          {radios}
        </DropdownMenuRadioGroup>
      )}
    </>
  );
}
