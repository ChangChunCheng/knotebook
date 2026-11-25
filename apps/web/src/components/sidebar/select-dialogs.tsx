import "@/i18n/select-strings";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DestTarget } from "./destination-level";

/**
 * Copy confirms first too, since it creates an extra copy. The plural move confirm is generic: it doesn't pre-look up each note's shares and public links.
 * While submitting (`progress` non-null) the dialog stays open until the batch ends: confirm and cancel disabled, progress shown; ✕, Esc and outside click all go through the Dialog root's `onOpenChange(false)` and are ignored here (`ui/dialog.tsx` unchanged). The caller sets `open` false at the end.
 * Import only through the SelectLazy chain and tests.
 */

export type SelectProgress = { done: number; total: number } | null;

interface ConfirmProps {
  count: number;
  open: boolean;
  progress: SelectProgress;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  contentRef?: Ref<HTMLDivElement>;
}

function ConfirmShell({
  title,
  description,
  submitLabel,
  submitVariant,
  open,
  progress,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  contentRef,
  children,
}: Omit<ConfirmProps, "count"> & {
  title: string;
  description: ReactNode;
  submitLabel: string;
  submitVariant: "destructive" | "outline";
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const busy = progress !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        ref={contentRef}
        dismissOnOutside={false}
        onCloseAutoFocus={onCloseAutoFocus}
        // Body controls (e.g. the keep-versions box) would otherwise take the first-tabbable default; confirm dialogs start on the safe button.
        onOpenAutoFocus={(event) => {
          const target = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector<HTMLElement>("[data-kb-autofocus]") : null;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {progress !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("select.progress", progress)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" data-kb-autofocus="" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant={submitVariant} disabled={busy} onClick={onConfirm}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveConfirmDialog({
  count,
  groupName,
  keepHistory,
  onKeepHistoryChange,
  ...rest
}: ConfirmProps & { groupName: string; keepHistory: boolean; onKeepHistoryChange: (keep: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmShell
      {...rest}
      title={t("share.move.moveSubmit")}
      description={t("select.moveLead", { count, group: groupName })}
      submitLabel={t("share.move.moveSubmit")}
      submitVariant="destructive"
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>{t("select.moveRemovesShares")}</li>
        <li>{t("select.moveClosesPublicLinks")}</li>
        <li>{t("select.moveUrlChange")}</li>
        <li>{t("select.moveOwnership")}</li>
        <li>{keepHistory ? t("select.moveKeepVersionsHint") : t("select.moveClearsVersions")}</li>
      </ul>
      <div className="flex items-center gap-2">
        <Checkbox
          id="select-move-keep-versions"
          checked={keepHistory}
          disabled={rest.progress !== null}
          onCheckedChange={(value) => onKeepHistoryChange(value === true)}
        />
        <label htmlFor="select-move-keep-versions" className="cursor-pointer text-sm">
          {t("select.moveKeepVersions")}
        </label>
      </div>
    </ConfirmShell>
  );
}

function copyCopy(t: (key: string, options?: Record<string, unknown>) => string, count: number, target: DestTarget, pathLabel: string) {
  if (target.kind === "makeCopy") return { label: t("share.move.copyHereSubmit"), lead: t("select.copyLeadMakeCopy", { count }) };
  if (target.space.kind === "group") return { label: t("share.move.copySubmit"), lead: t("select.copyLead", { count, group: pathLabel }) };
  const lead = target.folder === null ? t("select.copyLeadPersonal", { count }) : t("select.copyLead", { count, group: pathLabel });
  return { label: t("share.move.copyPersonalSubmit"), lead };
}

export function CopyConfirmDialog({ count, target, pathLabel, ...rest }: ConfirmProps & { target: DestTarget; pathLabel: string }) {
  const { t } = useTranslation();
  const { label, lead } = copyCopy(t, count, target, pathLabel);
  return <ConfirmShell {...rest} title={label} description={lead} submitLabel={label} submitVariant="outline" />;
}

/** Batch unfavorite confirm (no undo, hence confirm first); the count is a snapshot the caller takes when it opens the dialog. */
export function UnfavoriteConfirmDialog({ count, ...rest }: ConfirmProps) {
  const { t } = useTranslation();
  return (
    <ConfirmShell
      {...rest}
      title={t("select.unfavoriteTitle", { count })}
      description={t("select.unfavoriteDescription")}
      submitLabel={t("note.favorite.removeConfirm")}
      submitVariant="destructive"
    />
  );
}

/** On the shared tab this is "remove": folders are only the user's own categories and notes go back to top level. */
export function DeleteFoldersConfirmDialog({
  folderCount,
  noteCount,
  alsoNotes,
  shared,
  ...rest
}: Omit<ConfirmProps, "count"> & { folderCount: number; noteCount: number; alsoNotes: number; shared: boolean }) {
  const { t } = useTranslation();
  if (shared) {
    return (
      <ConfirmShell
        {...rest}
        title={t("select.removeFoldersTitle", { count: folderCount })}
        description={t("select.removeFoldersBody")}
        submitLabel={t("select.removeConfirm")}
        submitVariant="destructive"
      />
    );
  }
  return (
    <ConfirmShell
      {...rest}
      title={t("select.deleteFoldersTitle", { count: folderCount })}
      // The extra sentence is in DialogDescription too (read with the body on open); the space between keeps the accessible description from fusing, while visually it starts a new line.
      description={
        <>
          <span>{t("select.deleteFoldersBody", { count: noteCount })}</span>
          {alsoNotes > 0 && (
            <>
              {" "}
              <span className="mt-2 block">{t("select.deleteFoldersAlsoNotes", { count: alsoNotes })}</span>
            </>
          )}
        </>
      }
      submitLabel={t("select.deleteConfirm")}
      submitVariant="destructive"
    />
  );
}
