import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { FOLDER_DEPTH_MAX, type FolderDeleteResultDto, type FolderDto, type FolderListDto, type FolderSpaceDto, type NoteDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";

export const FOLDERS_QUERY_KEY = ["folders"] as const;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Not in tree order; the tree is built in components/sidebar/folder-index.ts. */
export async function fetchFolders(): Promise<FolderDto[]> {
  return (await api<FolderListDto>("/api/folders")).folders;
}

export function useFolders(): UseQueryResult<FolderDto[]> {
  return useQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: fetchFolders });
}

/** `trash: true` when trash rows' `folderPath` changes (rename, delete). */
export function invalidateFolderRelated(queryClient: QueryClient, opts: { trash?: boolean } = {}): void {
  void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  if (opts.trash === true) void queryClient.invalidateQueries({ queryKey: ["trash"] });
}

export type CreateFolderInput = { name: string; parentId: string } | { name: string; space: FolderSpaceDto };

export function createFolderRequest(input: CreateFolderInput): Promise<FolderDto> {
  return api<FolderDto>("/api/folders", { method: "POST", body: JSON.stringify(input) });
}

export function renameFolderRequest(id: string, name: string): Promise<FolderDto> {
  return api<FolderDto>(`/api/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function placeNoteRequest(noteId: string, folderId: string | null): Promise<NoteDto> {
  return api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/folder`, { method: "PUT", body: JSON.stringify({ folderId }) });
}

export function moveFolderRequest(id: string, parentId: string | null): Promise<FolderDto> {
  return api<FolderDto>(`/api/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ parentId }) });
}

export function applyPlacedNote(queryClient: QueryClient, note: NoteDto): void {
  queryClient.setQueryData(["note", note.id], note);
  invalidateFolderRelated(queryClient);
}

export function deleteFolderRequest(id: string, opts?: { onlyIfEmpty: true }): Promise<FolderDeleteResultDto> {
  const url = `/api/folders/${encodeURIComponent(id)}`;
  if (opts === undefined) return api<FolderDeleteResultDto>(url, { method: "DELETE" });
  return api<FolderDeleteResultDto>(url, { method: "DELETE", body: JSON.stringify({ onlyIfEmpty: true }) });
}

export function useCreateFolder(): UseMutationResult<FolderDto, unknown, CreateFolderInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFolderInput) => createFolderRequest(input),
    onSettled: () => {
      invalidateFolderRelated(queryClient);
    },
  });
}

export function useRenameFolder(): UseMutationResult<FolderDto, unknown, { id: string; name: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameFolderRequest(id, name),
    onSettled: () => {
      invalidateFolderRelated(queryClient, { trash: true });
    },
  });
}

/** Invalidates each trashed `["note", id]` so an open note switches to its in-trash state. */
export function useDeleteFolder(): UseMutationResult<FolderDeleteResultDto, unknown, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFolderRequest(id),
    onSuccess: (result) => {
      for (const id of result.trashedNoteIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
    },
    onSettled: () => {
      invalidateFolderRelated(queryClient, { trash: true });
      void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    },
  });
}

export function isFolderNotFound(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_not_found";
}

export function isFolderNotEmpty(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_not_empty";
}

export function folderErrorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { max: FOLDER_DEPTH_MAX, defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}
