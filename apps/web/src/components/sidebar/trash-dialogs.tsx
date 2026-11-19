import { useTranslation } from "react-i18next";
import type { TrashItemDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { TrashBatchError, trashErrorCause } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { splitTrashSections, trashResultMessage } from "@/lib/trash-display";

/** Callers close the dialog on success and failure alike and report via toast (on failure the list refetches and the count inside the dialog would visibly change). */

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface ConfirmShellProps {
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function PurgeConfirmDialog({ count, open, pending, onConfirm, onOpenChange, onCloseAutoFocus }: ConfirmShellProps & { count: number }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("trash.purgeTitle", { count })}</DialogTitle>
          <DialogDescription>{t("trash.purgeDescription")}</DialogDescription>
        </DialogHeader>
        <ConfirmFooter pending={pending} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

/** Per section: at least one item wasn't deleted by me (`deletedBy: null` = deleted account, counts as someone else). */
function deletedByOthers(items: readonly TrashItemDto[], meHandle: string | null): boolean {
  return items.some((item) => item.deletedBy === null || item.deletedBy.handle !== meHandle);
}

export function EmptyTrashDialog({
  items,
  meHandle,
  open,
  pending,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: ConfirmShellProps & { items: readonly TrashItemDto[]; meHandle: string | null }) {
  const { t } = useTranslation();
  const { personal, workspace } = splitTrashSections(items);
  // The leading separator is in the key's value (en has a space, zh-TW's full-width parenthesis none); this only concatenates.
  const line = (key: "trash.emptyPersonal" | "trash.emptyWorkspace", section: readonly TrashItemDto[]) =>
    t(key, { count: section.length }) + (deletedByOthers(section, meHandle) ? t("trash.includesOthers") : "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("trash.emptyTitle")}</DialogTitle>
          <DialogDescription>{t("trash.emptyDescription", { count: items.length })}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {personal.length > 0 && <li>{line("trash.emptyPersonal", personal)}</li>}
          {workspace.length > 0 && <li>{line("trash.emptyWorkspace", workspace)}</li>}
        </ul>
        <ConfirmFooter pending={pending} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmFooter({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          {t("home.cancel")}
        </Button>
      </DialogClose>
      <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
        {t("trash.purge")}
      </Button>
    </DialogFooter>
  );
}

type TrashResult = TrashRestoreResultDto | TrashPurgeResultDto;
type TrashKind = "restore" | "purge";

function doneCount(result: TrashResult): number {
  return "restored" in result ? result.restored.length : result.purged.length;
}

export function toastTrashResult(kind: TrashKind, result: TrashResult, t: Translate): void {
  const done = doneCount(result);
  toast({ title: trashResultMessage(kind, done, result.skipped.length, t), variant: done === 0 ? "destructive" : "default" });
}

/** On a mid-batch failure the description reports how many finished; a first-batch failure did nothing, so no "restored 0". */
export function toastTrashFailure(kind: TrashKind, err: unknown, t: Translate): void {
  const cause = trashErrorCause(err);
  const title = cause instanceof ApiFail ? t(`errors.${cause.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
  let description: string | undefined;
  if (err instanceof TrashBatchError) {
    const partial = err.partial as TrashResult;
    if (doneCount(partial) + partial.skipped.length > 0) description = trashResultMessage(kind, doneCount(partial), partial.skipped.length, t);
  }
  toast({ title, description, variant: "destructive" });
}
