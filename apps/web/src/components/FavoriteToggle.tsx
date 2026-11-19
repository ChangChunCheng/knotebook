import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { errorMessage, useAddFavorite, useFavoriteStatus, useRemoveFavorite } from "@/api/favorites";
import { FavoriteRemoveDialog } from "@/components/FavoriteRemoveDialog";
import { Button } from "@/components/ui/button";
import { HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { cn } from "@/lib/utils";
import { Star } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";

/**
 * `aria-disabled` + early return while submitting, not `disabled`: `disabled` drops keyboard focus to body.
 * Hidden below 18rem (header is an `@container`): the star would push share or ⋮ out of the card; the ⋮ menu item of the same name takes over.
 */
export function FavoriteToggle({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const { ready, favorite, pending } = useFavoriteStatus(note.id);
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);

  async function handleClick(): Promise<void> {
    if (pending) return;
    if (favorite) {
      setConfirming(true);
      return;
    }
    try {
      await addFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleConfirmRemove(): Promise<void> {
    try {
      await removeFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    setConfirming(false);
  }

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "shrink-0 text-brand hover:text-brand aria-disabled:cursor-not-allowed aria-disabled:opacity-50 @max-[18rem]:hidden",
          HEADER_ICON_HIT,
        )}
        aria-label={t("note.favorite.label")}
        aria-pressed={favorite}
        aria-disabled={pending ? true : undefined}
        title={favorite ? t("note.menu.removeFavorite") : t("note.menu.addFavorite")}
        // `disabled`, not aria-disabled: no focus to keep until ready.
        disabled={!ready}
        onClick={() => void handleClick()}
      >
        <Star className="h-4 w-4" fill={favorite ? "currentColor" : "none"} />
      </Button>
      <FavoriteRemoveDialog
        title={note.title}
        open={confirming}
        pending={removeFavorite.isPending}
        onConfirm={() => void handleConfirmRemove()}
        onOpenChange={setConfirming}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          buttonRef.current?.focus();
        }}
      />
    </>
  );
}
