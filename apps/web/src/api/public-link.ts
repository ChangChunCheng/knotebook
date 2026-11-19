import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { NoteWidth } from "@knotebook/shared";
import { api } from "./client";

/** GET, PUT and PUT `/slug` must return all three keys: responses are written straight into the cache, so a missing key
 * would blank that row (server tests pin the full shape). */
export interface PublicLinkDto {
  token: string | null;
  slug: string | null;
  width: NoteWidth;
}

/** The server answers 403/404 without `permissions.managePublicLink`; callers then pass "" to keep the query disabled.
 * `ShareDialog` fetches this on note load (for the trigger icon), not only when the dialog opens. */
export function usePublicLink(noteId: string): UseQueryResult<PublicLinkDto> {
  return useQuery({
    queryKey: ["public-link", noteId],
    queryFn: () => api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link`),
    enabled: noteId.length > 0,
  });
}

/** Every PUT regenerates the token (not idempotent). The client PUTs only when token is null (Regenerate PUTs on purpose). The response is written straight into the cache, with no refetch (saves a round trip and keeps the sticky selection from an extra refetch). */
export function useCreatePublicLink(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link`, { method: "PUT" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["public-link", noteId], data);
    },
  });
}

export function useSetPublicSlug(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link/slug`, {
        method: "PUT",
        body: JSON.stringify({ slug }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["public-link", noteId], data);
    },
  });
}

/** Updates only `slug`; writing `{token: null, slug: null}` like revoke does would hide the link row. */
export function useClearPublicSlug(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/notes/${encodeURIComponent(noteId)}/public-link/slug`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], (prev) =>
        prev ? { ...prev, slug: null } : prev,
      );
    },
  });
}

/** The server clears the slug in the same UPDATE, so clear it here too; `width` is kept (the server doesn't reset it). */
export function useDeletePublicLink(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/notes/${encodeURIComponent(noteId)}/public-link`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], (prev) =>
        prev ? { ...prev, token: null, slug: null } : prev,
      );
    },
  });
}

/** Merges only `width`: a late response would otherwise write back a token regenerated or revoked meanwhile. */
export function useSetPublicWidth(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (width: NoteWidth) =>
      api<{ width: NoteWidth }>(`/api/notes/${encodeURIComponent(noteId)}/public-width`, {
        method: "PUT",
        body: JSON.stringify({ width }),
      }),
    onSuccess: ({ width }) => {
      queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], (prev) => (prev ? { ...prev, width } : prev));
    },
  });
}
