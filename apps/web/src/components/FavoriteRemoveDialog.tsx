import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Not `sidebar/select-dialogs.tsx`: that is lazy-only (`SelectLazy`) but the ⋮ menu is in the initial bundle.
 * Cancel is the first footer child so initial focus is the safe action.
 */
interface FavoriteRemoveDialogProps {
  title: string;
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}

export function FavoriteRemoveDialog({ title, open, pending, onConfirm, onOpenChange, onCloseAutoFocus }: FavoriteRemoveDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("note.favorite.removeTitle")}</DialogTitle>
          <DialogDescription>
            {t("note.favorite.removeDescription", { title: title.trim() === "" ? t("note.titlePlaceholder") : title })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("note.favorite.removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
