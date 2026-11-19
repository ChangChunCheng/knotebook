import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { invalidateTrashRelated, partialRestored, restoreTrashIds, seedRestoredNotes, trashErrorCause } from "@/api/trash";
import { expandAfterRestore } from "@/components/sidebar/folder-index";
import { toast } from "@/components/ui/toast";
import { canRestoreAfterTrash, trashResultMessage } from "@/lib/trash-display";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** The undo handler uses only values captured from the arguments: the toast is often clicked after the menu has unmounted. */
export function showTrashedToast(args: {
  notes: ReadonlyArray<Pick<NoteDto, "id" | "group" | "permissions">>;
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopen: boolean;
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
  reopenId?: string | null;
  /** Id-only notes (from folder delete): merged into the ids to undo, not counted in the "whole batch can restore itself" test. */
  undoIds?: readonly string[];
}): void {
  const { notes, queryClient, navigate, t, reopen, description, variant } = args;
  const title = args.title ?? t("trash.moved");
  if (!notes.every(canRestoreAfterTrash)) {
    // A group note where the user has delete but not edit permission cannot be restored by them; the toast only says who can.
    const hint = t("trash.movedNoUndoHint");
    toast({ title, description: description === undefined ? hint : `${description} ${hint}`, variant });
    return;
  }
  const ids = [...new Set([...notes.map((note) => note.id), ...(args.undoIds ?? [])])];
  const reopenId = args.reopenId !== undefined ? args.reopenId : reopen && ids.length === 1 ? ids[0] : null;
  toast({
    title,
    description,
    variant,
    action: {
      label: t("trash.undo"),
      onClick: () => void undoTrash({ ids, queryClient, navigate, t, reopenId }),
    },
  });
}

/** The seed must happen before navigate. */
export async function undoTrash(args: {
  ids: readonly string[];
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopenId: string | null;
}): Promise<void> {
  const { ids, queryClient, navigate, t, reopenId } = args;
  let restored: NoteDto[] = [];
  try {
    const result = await restoreTrashIds(ids);
    restored = result.restored;
    seedRestoredNotes(queryClient, result.restored);
    toast({
      title: trashResultMessage("restore", result.restored.length, result.skipped.length, t),
      variant: result.restored.length === 0 ? "destructive" : "default",
    });
    const back = reopenId !== null ? result.restored.find((note) => note.id === reopenId) : undefined;
    if (back) void navigate(canonicalNotePath(back));
  } catch (err) {
    // Failure midway through batches: the notes that did succeed are still written back and counted.
    restored = partialRestored(err);
    seedRestoredNotes(queryClient, restored);
    toast({
      title: errorMessage(t, trashErrorCause(err)),
      description: restored.length > 0 ? t("trash.restored", { count: restored.length }) : undefined,
      variant: "destructive",
    });
  } finally {
    invalidateTrashRelated(queryClient, ids);
  }
  // Must come after the invalidation (see expandAfterRestore).
  void expandAfterRestore(queryClient, restored);
}
