// Lazy module: load only via import("@/lib/stack-folder"), so its folder strings stay out of the main bundle (scripts/check-bundle-size.mjs).
import "@/i18n/folder-strings";
import type { QueryClient } from "@tanstack/react-query";
import type { FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  createFolderRequest,
  deleteFolderRequest,
  FOLDERS_QUERY_KEY,
  folderErrorMessage,
  invalidateFolderRelated,
  isFolderNotEmpty,
  isFolderNotFound,
  placeNoteRequest,
} from "@/api/folders";
import type { Translate } from "@/components/sidebar/destination-level";
import { stackFolderName } from "@/components/sidebar/drag-zone";
import { toast } from "@/components/ui/toast";

export const STACK_CREATE_ATTEMPTS = 5;

export interface StackNote {
  noteId: string;
  from: string | null;
}

function isNameTaken(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_name_taken";
}

function errorToast(t: Translate, err: unknown): void {
  toast({ title: folderErrorMessage(t, err), variant: "destructive" });
}

async function place(queryClient: QueryClient, noteId: string, folderId: string | null): Promise<void> {
  const note: NoteDto = await placeNoteRequest(noteId, folderId);
  queryClient.setQueryData(["note", note.id], note);
}

async function createWithRetry(input: {
  parent: { folderId: string } | { space: FolderSpaceDto };
  firstName: string;
  takenNames: readonly string[];
  t: Translate;
}): Promise<FolderDto> {
  const { parent, takenNames, t } = input;
  const tried = new Set<string>();
  let name = input.firstName;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createFolderRequest("folderId" in parent ? { name, parentId: parent.folderId } : { name, space: parent.space });
    } catch (err) {
      if (!isNameTaken(err) || attempt >= STACK_CREATE_ATTEMPTS) throw err;
      tried.add(name);
      name = stackFolderName(takenNames, t, tried);
    }
  }
}

/** If DELETE returns 409 folder_not_empty (someone just put something in), keep the folder and stop. */
async function compensate(args: { folderId: string; b: StackNote | null; queryClient: QueryClient }): Promise<void> {
  const { folderId, b, queryClient } = args;
  try {
    if (b !== null) await place(queryClient, b.noteId, b.from);
    await deleteFolderRequest(folderId, { onlyIfEmpty: true });
  } catch {
    // Refetch whatever the error: on 409 folder_not_empty the folder is kept but not in the cache yet, so without a refetch the sidebar would only show it after a reload.
    invalidateFolderRelated(queryClient);
  }
}

/** Not optimistic: the new folder's id comes from the server. */
export async function runStackFolder(input: {
  a: StackNote;
  b: StackNote;
  parent: { folderId: string } | { space: FolderSpaceDto };
  firstName: string;
  takenNames: readonly string[];
  queryClient: QueryClient;
  t: Translate;
}): Promise<FolderDto | null> {
  const { a, b, queryClient, t } = input;
  let folder: FolderDto;
  try {
    folder = await createWithRetry(input);
  } catch (err) {
    // The cache may be stale (parent folder deleted, name-clash attempts used up).
    invalidateFolderRelated(queryClient);
    errorToast(t, err);
    return null;
  }
  try {
    await place(queryClient, b.noteId, folder.id);
  } catch (err) {
    await compensate({ folderId: folder.id, b: null, queryClient });
    errorToast(t, err);
    return null;
  }
  try {
    await place(queryClient, a.noteId, folder.id);
  } catch (err) {
    await compensate({ folderId: folder.id, b, queryClient });
    errorToast(t, err);
    return null;
  }
  await Promise.all([queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY }), queryClient.invalidateQueries({ queryKey: ["notes"] })]);
  return folder;
}

export async function undoStackFolder(args: { folderId: string; a: StackNote; b: StackNote; queryClient: QueryClient; t: Translate }): Promise<void> {
  const { folderId, a, b, queryClient, t } = args;
  try {
    await place(queryClient, a.noteId, a.from);
    await place(queryClient, b.noteId, b.from);
  } catch (err) {
    invalidateFolderRelated(queryClient);
    errorToast(t, err);
    return;
  }
  try {
    await deleteFolderRequest(folderId, { onlyIfEmpty: true });
  } catch (err) {
    if (isFolderNotEmpty(err)) toast({ title: t("folderDialogs.stackKept") });
    else if (!isFolderNotFound(err)) errorToast(t, err);
  }
  invalidateFolderRelated(queryClient);
}

export function showStackCreatedToast(args: { folderId: string; name: string; a: StackNote; b: StackNote; queryClient: QueryClient; t: Translate }): void {
  const { folderId, name, a, b, queryClient, t } = args;
  toast({
    title: t("folderDialogs.stackCreated", { name }),
    action: { label: t("trash.undo"), onClick: () => void undoStackFolder({ folderId, a, b, queryClient, t }) },
  });
}
