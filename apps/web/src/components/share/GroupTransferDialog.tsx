import { useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { folderErrorMessage, invalidateFolderRelated, isFolderNotFound } from "@/api/folders";
import { useConfirmNoteStillPersonal, useCopyNote, useMoveNoteToGroup } from "@/api/note-move";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { GroupTransferPick, TransferTarget } from "./GroupTransfer";

/**
 * Split from `GroupTransfer.tsx`: the menu items render synchronously in the open menu, while this is needed only
 * after a destination is picked, so `NoteMenu` can lazy-load it (initial bundle size).
 */

/**
 * - MoveDialog's submit stays disabled until both shares and public-link queries succeed (partial data
 *   under-reports who loses access). Only MoveDialog issues them: copy doesn't need them, and on group/shared notes they 403-retry.
 * - Before submitting, `useConfirmNoteStillPersonal` re-reads the note; if it is no longer a personal note I can move,
 *   nothing is sent and a `changedElsewhere` toast shows. That hook returns a new function every render: call it only
 *   in the submit handler, never in effect deps.
 * - On a successful move the hook writes shares/public-link before `['note', id]` (ordering contract in
 *   `api/note-move.ts`); the page then reads only the response's `role`/`permissions` and doesn't assume it can
 *   still edit.
 * - Failures toast (`folderErrorMessage`, with `max`) and close: the menu is already closed, so there is nowhere for
 *   inline errors. While submitting (including the pre-submit check) the buttons are disabled and the dialog can't
 *   close, so a resubmit can't make a second copy.
 * - Focus returns to `returnFocusRef`: Radix restores focus via `DialogTrigger`, which isn't used here, so it would fall to body.
 */
interface DialogShellProps {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  footer: ReactNode;
}

function DialogShell({ title, description, busy, onClose, returnFocusRef, children, footer }: DialogShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        dismissOnOutside={false}
        data-testid="group-transfer-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef?.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TransferDialogProps {
  note: NoteDto;
  target: TransferTarget;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function MoveDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const group = target.type === "group" ? target.group : null;
  const folder = target.type === "group" ? target.folder : undefined;
  const destination = folder?.path ?? group?.name ?? "";
  const { t, i18n } = useTranslation();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const confirmStillPersonal = useConfirmNoteStillPersonal(note.id);
  const [submitting, setSubmitting] = useState(false);
  const [keepVersions, setKeepVersions] = useState(false);

  const busy = submitting || move.isPending;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    shares.map((share) => share.displayName),
  );

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      if (!(await confirmStillPersonal())) {
        toast({ title: t("share.move.changedElsewhere") });
        return;
      }
      if (group === null) return;
      await move.mutateAsync(
        folder === undefined ? { groupId: group.id, keepVersions } : { groupId: group.id, folderId: folder.id, keepVersions },
      );
      toast({ title: t("share.move.movedToGroup", { group: destination }) });
    } catch (err) {
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={t("share.move.moveSubmit")}
      description={t("share.move.moveLead", { group: destination })}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !dataKnown} onClick={() => void submit()}>
            {t("share.move.moveSubmit")}
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {shares.length > 0 && <li>{t("share.move.moveRemovesPeople", { count: shares.length, names })}</li>}
        {token && <li>{t("share.move.moveClosesPublicLink")}</li>}
        <li>{t("share.move.moveUrlChange")}</li>
        <li>{t("share.move.moveOwnership")}</li>
        <li>{keepVersions ? t("share.move.keepVersionsHint") : t("share.move.moveClearsVersions")}</li>
      </ul>
      <div className="flex items-center gap-2">
        <Checkbox id="move-keep-versions" checked={keepVersions} disabled={busy} onCheckedChange={(value) => setKeepVersions(value === true)} />
        <label htmlFor="move-keep-versions" className="cursor-pointer text-sm">
          {t("share.move.keepVersions")}
        </label>
      </div>
    </DialogShell>
  );
}

type CopyInput = { groupId?: string; folderId?: string };

/**
 * Top level never sends `folderId`. Duplicate lands in the source's folder; `fallback` (only for duplicate/inPlace
 * of a note in a folder) is the retry body without `folderId`.
 * A shared note copied to my notes omits its own placement: `note.folderId` is the caller's view.
 */
function copyRequest(note: NoteDto, target: TransferTarget): { input: CopyInput; fallback: CopyInput | null } {
  const groupPart: CopyInput = target.type === "group" || target.type === "inPlace" ? { groupId: target.group.id } : {};
  if (target.type === "duplicate" || target.type === "inPlace") {
    if (note.folderId === null) return { input: groupPart, fallback: null };
    return { input: { ...groupPart, folderId: note.folderId }, fallback: groupPart };
  }
  return { input: target.folder === undefined ? groupPart : { ...groupPart, folderId: target.folder.id }, fallback: null };
}

function CopyDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopyNote(note.id);
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || copy.isPending;
  const submitLabel =
    target.type === "group"
      ? t("share.move.copySubmit")
      : target.type === "personal"
        ? t("share.move.copyPersonalSubmit")
        : t("share.move.copyHereSubmit");
  const lead =
    target.type === "group"
      ? t("share.move.copyLead", { group: target.folder?.path ?? target.group.name })
      : target.type === "inPlace"
        ? t("share.move.copyLeadInPlace", { group: target.group.name })
        : target.type === "personal" && target.folder !== undefined
          ? t("share.move.copyLead", { group: target.folder.path })
          : t("share.move.copyLeadPersonal");
  const copiedTitle =
    target.type === "group" || target.type === "inPlace"
      ? t("share.move.copiedToGroup", { group: target.group.name })
      : t("share.move.copiedToPersonal");

  async function submit(): Promise<void> {
    setSubmitting(true);
    const request = copyRequest(note, target);
    try {
      let created: NoteDto;
      let atTopLevel = false;
      try {
        created = await copy.mutateAsync(request.input);
      } catch (err) {
        // Only a stale cached folderId (duplicate) retries at top level; an explicitly picked folder rethrows.
        if (request.fallback === null || !isFolderNotFound(err)) throw err;
        invalidateFolderRelated(queryClient);
        created = await copy.mutateAsync(request.fallback);
        atTopLevel = true;
      }
      toast({
        title: atTopLevel ? t("share.move.copiedAtTopLevel") : copiedTitle,
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
    } catch (err) {
      if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={submitLabel}
      description={lead}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    />
  );
}

export function GroupTransferDialog({
  note,
  pick,
  onClose,
  returnFocusRef,
}: {
  note: NoteDto;
  pick: GroupTransferPick;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const Body = pick.kind === "move" ? MoveDialog : CopyDialog;
  return <Body note={note} target={pick.target} onClose={onClose} returnFocusRef={returnFocusRef} />;
}
