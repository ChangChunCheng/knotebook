import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ShareDto, ShareRole } from "@knotebook/shared";
import { api } from "./client";

/** No `enabled` flag: only mounted while the share dialog is open. */
export function useShares(noteId: string): UseQueryResult<ShareDto[]> {
  return useQuery({
    queryKey: ["shares", noteId],
    queryFn: () => api<ShareDto[]>(`/api/notes/${encodeURIComponent(noteId)}/shares`),
    enabled: noteId.length > 0,
  });
}

export function usePutShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: ShareRole }) =>
      api<ShareDto>(`/api/notes/${encodeURIComponent(noteId)}/shares`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shares", noteId] });
    },
  });
}

/** Only the list is invalidated: the revoked user's own client reacts through `useCollab`. */
export function useDeleteShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/notes/${encodeURIComponent(noteId)}/shares/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shares", noteId] });
    },
  });
}
