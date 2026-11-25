import "@/i18n/comments-strings";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CommentDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useEditComment, usePostComment } from "@/api/comments";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import type { CommentDraftAnchor } from "@/lib/comments-context";
import { authorName } from "./comment-format";

export interface CommentComposerProps {
  noteId: string;
  /** Passage a new comment is attached to; null = a comment on the whole note. Not used while editing. */
  draftAnchor: CommentDraftAnchor | null;
  onClearAnchor: () => void;
  /** The comment a new one answers; null = not a reply. */
  replyTo: CommentDto | null;
  /** The comment being edited; null = writing a new one. */
  editing: CommentDto | null;
  /** After a successful post or save, with the comment the server returned; with null when a reply or edit is cancelled. */
  onDone: (saved: CommentDto | null) => void;
}

/** Remount it (`key`) when `editing` changes: the text starts from the edited comment's body. */
export function CommentComposer({ noteId, draftAnchor, onClearAnchor, replyTo, editing, onDone }: CommentComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(editing?.body ?? "");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (replyTo !== null || editing !== null) boxRef.current?.focus();
  }, [replyTo, editing]);
  const post = usePostComment(noteId);
  const edit = useEditComment();
  const pending = post.isPending || edit.isPending;
  const canSend = text.trim() !== "" && !pending && (editing === null || text !== editing.body);

  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"),
      variant: "destructive",
    });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    if (editing !== null) {
      edit.mutate({ commentId: editing.id, body: text }, { onSuccess: (saved) => onDone(saved), onError: fail });
      return;
    }
    post.mutate(
      {
        body: text,
        ...(replyTo !== null ? { replyToId: replyTo.id } : {}),
        ...(draftAnchor !== null ? { anchor: { blockId: draftAnchor.blockId, quote: draftAnchor.quote === "" ? null : draftAnchor.quote } } : {}),
      },
      {
        onSuccess: (saved) => {
          setText("");
          onClearAnchor();
          onDone(saved);
        },
        onError: fail,
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const context = editing !== null ? t("comments.composer.editing") : replyTo !== null ? t("comments.composer.replyingTo", { who: authorName(replyTo) }) : null;

  return (
    <form data-testid="comment-composer" onSubmit={submit} className="space-y-2 border-t border-border p-3">
      {context !== null && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{context}</span>
          <Button type="button" variant="ghost" size="sm" className="px-2 text-xs" onClick={() => onDone(null)}>
            {t("comments.cancel")}
          </Button>
        </div>
      )}
      {editing === null && draftAnchor !== null && (
        <div data-testid="composer-anchor" className="flex items-start gap-1 rounded-md border-l-2 border-brand bg-muted px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 line-clamp-2">{draftAnchor.quote || t("comments.passage")}</span>
          <button type="button" aria-label={t("comments.composer.removePassage")} onClick={onClearAnchor} className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent pointer-coarse:p-2">
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      )}
      <textarea
        ref={boxRef}
        aria-label={t("comments.composer.label")}
        placeholder={t("comments.composer.placeholder")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        className="block w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:text-base"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="brandDeep" disabled={!canSend}>
          {editing !== null ? t("comments.composer.save") : t("comments.composer.send")}
        </Button>
      </div>
    </form>
  );
}
