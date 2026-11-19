import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { NoteEditDto, NoteEditResultDto } from "@knotebook/shared";
import { api } from "./client";

export const NOTE_EDITS_QUERY_KEY = (noteId: string) => ["note-edits", noteId] as const;

/** `enabled` is required: fetch only while the edits dialog is open. `AiEditsDialog.test.tsx` guards this; NotePage tests
 * can't (their catch-all mock answers it, and a rejection would only sit in this query's error state). */
export function useNoteEdits(noteId: string, options: { enabled: boolean }): UseQueryResult<NoteEditDto[]> {
  return useQuery({
    queryKey: NOTE_EDITS_QUERY_KEY(noteId),
    queryFn: () =>
      api<{ edits: NoteEditDto[] }>(`/api/notes/${encodeURIComponent(noteId)}/edits`).then(body => body.edits),
    enabled: options.enabled,
  });
}

/** Invalidates only the edits list; the caller invalidates the note via `invalidateNoteQueries`, which needs the `NoteDto`. */
export function useRevertEdit(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (editId: string) =>
      api<NoteEditResultDto>(
        `/api/notes/${encodeURIComponent(noteId)}/edits/${encodeURIComponent(editId)}/revert`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTE_EDITS_QUERY_KEY(noteId) });
    },
  });
}
