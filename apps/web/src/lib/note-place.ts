import type { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { applyPlacedNote, folderErrorMessage, invalidateFolderRelated, isFolderNotFound, placeNoteRequest } from "@/api/folders";
import { expandFolderChain, type FolderIndex } from "@/components/sidebar/folder-index";
import { toast } from "@/components/ui/toast";

/** First-load module: does not import the string bundle. */

type Translate = (key: string, options?: Record<string, unknown>) => string;

function invalidateIfFolderGone(queryClient: QueryClient, err: unknown): void {
  if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
}

function setCachedFolderId(queryClient: QueryClient, noteId: string, folderId: string | null): void {
  queryClient.setQueryData<NoteDto[]>(["notes"], (list) => list?.map((note) => (note.id === noteId ? { ...note, folderId } : note)));
}

/**
 * The toast handler uses only captured values: by the time "Undo" is pressed the menu has often
 * unmounted. Optimistic (drag): cancel in-flight ["notes"] requests (exact key, so the version
 * panel's ["notes", id, "versions"] is left alone) and expand the target chain so the note does
 * not vanish on a collapsed folder; on failure restore only this note's folderId so others'
 * concurrent writes survive.
 */
export async function placeNoteWithUndo(args: {
  noteId: string;
  from: string | null;
  to: { folderId: string | null; name: string };
  index: FolderIndex;
  queryClient: QueryClient;
  t: Translate;
  optimistic?: true;
}): Promise<void> {
  const { noteId, from, to, index, queryClient, t } = args;
  const optimistic = args.optimistic === true;
  let previous: { folderId: string | null } | undefined;
  if (optimistic) {
    await queryClient.cancelQueries({ queryKey: ["notes"], exact: true });
    const note = queryClient.getQueryData<NoteDto[]>(["notes"])?.find((item) => item.id === noteId);
    if (note !== undefined) {
      previous = { folderId: note.folderId };
      setCachedFolderId(queryClient, noteId, to.folderId);
    }
    if (to.folderId !== null) expandFolderChain(index, to.folderId);
  }
  try {
    const placed = await placeNoteRequest(noteId, to.folderId);
    applyPlacedNote(queryClient, placed);
    if (to.folderId !== null) expandFolderChain(index, to.folderId);
  } catch (err) {
    if (previous !== undefined) setCachedFolderId(queryClient, noteId, previous.folderId);
    invalidateIfFolderGone(queryClient, err);
    // Optimistic cancelled in-flight ["notes"] requests, so refetch on non-404 failures too.
    if (optimistic && !isFolderNotFound(err)) void queryClient.invalidateQueries({ queryKey: ["notes"] });
    toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    return;
  }
  toast({
    title: t("folders.movedTo", { name: to.name }),
    action: { label: t("trash.undo"), onClick: () => void undoPlace({ noteId, from, queryClient, t }) },
  });
}

async function undoPlace(args: { noteId: string; from: string | null; queryClient: QueryClient; t: Translate }): Promise<void> {
  const { noteId, from, queryClient, t } = args;
  try {
    applyPlacedNote(queryClient, await placeNoteRequest(noteId, from));
  } catch (err) {
    invalidateIfFolderGone(queryClient, err);
    toast({ title: folderErrorMessage(t, err), variant: "destructive" });
  }
}
