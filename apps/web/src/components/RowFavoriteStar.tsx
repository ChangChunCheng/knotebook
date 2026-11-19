import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { errorMessage, useAddFavorite, useRemoveFavorite } from "@/api/favorites";
import { FavoriteRemoveDialog } from "@/components/FavoriteRemoveDialog";
import { Button } from "@/components/ui/button";
import { Star } from "@/components/ui/icons";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
import { hoverRevealOnly, NOTE_STAR_TOUCH_HIDDEN } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { captureRemoveContext, focusAfterRemoveLater, type RemoveContext } from "@/lib/favorite-focus";
import { cn } from "@/lib/utils";

/** State comes from `NoteList` (one `["favorites"]` subscription per list, not per row). `aria-disabled` + early return while submitting, not `disabled`, to keep keyboard focus. The row unmounts after a successful removal in the favourites tab, so closing and focus handling happen after the `await`, using the neighbour recorded at open. */
export function RowFavoriteStar({ note, favorite, pending }: { note: NoteDto; favorite: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [removing, setRemoving] = useState<RemoveContext | null>(null);

  async function handleClick(): Promise<void> {
    if (pending) return;
    if (favorite) {
      setRemoving(captureRemoveContext(buttonRef.current));
      return;
    }
    try {
      await addFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleConfirmRemove(ctx: RemoveContext): Promise<void> {
    try {
      await removeFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    setRemoving(null);
    focusAfterRemoveLater(ctx);
  }

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, favorite ? cn("text-brand hover:text-brand", NOTE_STAR_TOUCH_HIDDEN) : cn("text-muted-foreground hover:text-brand", hoverRevealOnly("noterow")))}
        aria-label={t("note.favorite.label")}
        aria-pressed={favorite}
        aria-disabled={pending ? true : undefined}
        title={favorite ? t("note.menu.removeFavorite") : t("note.menu.addFavorite")}
        onClick={() => void handleClick()}
      >
        <Star aria-hidden="true" className="h-3.5 w-3.5" fill={favorite ? "currentColor" : "none"} />
      </Button>
      {removing !== null && (
        <FavoriteRemoveDialog
          title={note.title}
          open
          pending={removeFavorite.isPending}
          onConfirm={() => void handleConfirmRemove(removing)}
          onOpenChange={(open) => {
            if (open) return;
            setRemoving(null);
            focusAfterRemoveLater(removing);
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        />
      )}
    </>
  );
}
