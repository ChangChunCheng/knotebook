import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import { api } from "./client";
import type { PublicLinkDto } from "./public-link";

function writeMovedNote(queryClient: QueryClient, note: NoteDto): void {
  queryClient.setQueryData(["note", note.id], note);
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
  void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
}

/** Writes `['shares']` and `['public-link']` before `['note']`, synchronously: a group note's ShareDialog reads
 * public-link and would flash "public" with the old token. */
export function applyMovedNote(queryClient: QueryClient, noteId: string, note: NoteDto): void {
  queryClient.setQueryData<ShareDto[]>(["shares", noteId], []);
  queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], prev => (prev ? { ...prev, token: null, slug: null } : prev));
  writeMovedNote(queryClient, note);
}

/** Awaits shares and public-link before invalidating note and groups. Call it with `void`; never return it from onError
 * (TanStack would wait, and `retry: 3` delays the error by about 7 s). */
export async function refetchAfterFailure(queryClient: QueryClient, noteId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
    queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
  ]);
  void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
  void queryClient.invalidateQueries({ queryKey: ["groups"] });
}

export function useMoveNoteToGroup(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation<NoteDto, Error, { groupId: string; folderId?: string }>({
    mutationFn: (input: { groupId: string; folderId?: string }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/move`, {
        method: "POST",
        body: JSON.stringify(input.folderId === undefined ? { groupId: input.groupId } : { groupId: input.groupId, folderId: input.folderId }),
      }),
    onSuccess: note => {
      applyMovedNote(queryClient, noteId, note);
    },
    onError: () => {
      void refetchAfterFailure(queryClient, noteId);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useCopyNote(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation<NoteDto, Error, { groupId?: string; folderId?: string }>({
    mutationFn: (input: { groupId?: string; folderId?: string }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/copy`, {
        method: "POST",
        body: JSON.stringify({
          ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
        }),
      }),
    onSuccess: copy => {
      queryClient.setQueryData(["note", copy.id], copy);
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/** Not `fetchQuery`: it writes the note cache on return, remounting the panel before shares are reconciled (stuck on "private"). */
export function useConfirmNoteStillPersonal(noteId: string) {
  const queryClient = useQueryClient();
  return async (): Promise<boolean> => {
    const latest = await api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}`);
    if (latest.groupId === null && latest.permissions.moveToGroup) return true;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
      queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
    ]);
    queryClient.setQueryData(["note", noteId], latest);
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
    void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    return false;
  };
}
