import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AI_EDITS_RETENTION, type NoteDto, type NoteEditDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useNoteEdits, useRevertEdit } from "@/api/noteEdits";
import { invalidateNoteQueries } from "@/api/notes";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

function notRevertableReason(t: (key: string) => string, edit: NoteEditDto): string {
  if (edit.revertedAt !== null) return t("aiEdits.reverted");
  if (edit.op === "revert") return t("aiEdits.revertRecord");
  return t("aiEdits.stale");
}

function EditRow({ note, edit }: { note: NoteDto; edit: NoteEditDto }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const revert = useRevertEdit(note.id);

  const who = edit.agentLabel === null ? edit.byHandle : `${edit.byHandle} (${edit.agentLabel})`;

  async function handleRevert(): Promise<void> {
    try {
      await revert.mutateAsync(edit.id);
      // Reverting changes the note body, so `last_edited_*` changes too. `ref` is `note.id`: this dialog only has a `NoteDto`; `NotePage` passes the route ref through its own remote-update path.
      invalidateNoteQueries(queryClient, note, note.id);
      toast({ title: t("aiEdits.revertOk") });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li data-testid={`ai-edit-${edit.id}`} className="flex items-start justify-between gap-3 rounded-md border border-border p-2">
      <Avatar name={edit.byHandle} avatar={edit.avatar ?? null} size={24} />
      <div className="min-w-0 flex-1 space-y-1">
        {/* handle and agent name are external strings: bidi-isolate */}
        <p dir="ltr" className="truncate text-sm [unicode-bidi:isolate]" data-testid="ai-edit-who">
          {who}
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date(edit.createdAt).toLocaleString(i18n.language)}
          {" · "}
          {/* op is the raw API literal on purpose: the list mirrors the op the caller sent, and a translation would hide that. Exception: `revert` is synthesized by the revert endpoint (apps/server/src/notes/editing/revert.ts), not sendable by callers */}
          <code>{edit.op}</code>
          {edit.heading !== "" && ` · ${edit.heading}`}
        </p>
      </div>
      {edit.revertable ? (
        <Button type="button" variant="outline" size="sm" disabled={revert.isPending} onClick={() => void handleRevert()}>
          {t("aiEdits.revert")}
        </Button>
      ) : (
        <span className="max-w-[14rem] text-right text-xs text-muted-foreground">{notRevertableReason(t, edit)}</span>
      )}
    </li>
  );
}

/**
 * State lives in `NotePage` because the dialog has two triggers (⋮ item and `LastEditedLabel`).
 * The list query is gated on `open`: `GET /api/notes/:id/edits` has a rate-limit bucket and NotePage mounts one dialog per opened note (pinned in AiEditsDialog.test.tsx).
 */
export function AiEditsDialog({
  note,
  open,
  onOpenChange,
}: {
  note: NoteDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const edits = useNoteEdits(note.id, { enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* no description: avoid a dangling aria-describedby */}
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("aiEdits.title")}</DialogTitle>
        </DialogHeader>
        {edits.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : edits.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, edits.error)}
          </p>
        ) : edits.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("aiEdits.empty")}</p>
        ) : (
          <>
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {edits.data.map(edit => (
                <EditRow key={edit.id} note={note} edit={edit} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("aiEdits.retentionNote", { count: AI_EDITS_RETENTION })}</p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
