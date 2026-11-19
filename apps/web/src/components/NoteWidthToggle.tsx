import { useTranslation } from "react-i18next";
import { NOTE_WIDTHS } from "@knotebook/shared";
import { useNoteWidth } from "@/components/note-width";
import { Button } from "@/components/ui/button";
import { HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { NoteWidthIcon } from "@/components/ui/icons-extra";
import { tourTarget } from "@/lib/tour-targets";
import { cn } from "@/lib/utils";

/** Shown only when the header content box is >= 43.5rem (header is an `@container`): below that wide equals standard; when hidden, the ⋮ menu sets the width. */
export function NoteWidthToggle({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useNoteWidth(noteId);
  const next = NOTE_WIDTHS[(NOTE_WIDTHS.indexOf(width) + 1) % NOTE_WIDTHS.length]!;
  const name = t("note.width.cycle", { name: t(`note.width.${width}`), next: t(`note.width.${next}`) });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={name}
      title={name}
      {...tourTarget("noteWidth")}
      onClick={() => setWidth(next)}
      className={cn("hidden shrink-0 text-brand hover:text-brand @min-[43.5rem]:inline-flex", HEADER_ICON_HIT)}
    >
      <NoteWidthIcon width={width} className="h-4 w-4" />
    </Button>
  );
}
