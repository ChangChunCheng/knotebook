import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { BacklinkDto, LastEditedDto, NoteDto } from "@knotebook/shared";
import { api } from "./client";

/** `["note", id]` matches by prefix and doesn't cover `["note", slug]`, so the route's current ref is passed separately. */
export function invalidateNoteQueries(
  queryClient: QueryClient,
  note: Pick<NoteDto, "id" | "ownerHandle" | "groupId" | "slug">,
  ref: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ["note", note.id] });
  if (ref !== note.id) void queryClient.invalidateQueries({ queryKey: ["note", ref] });
  // Same test as `canonicalNotePath`: `typeof === "string"`, not `!== null`, so old objects without `groupId` aren't group notes.
  if (typeof note.groupId === "string") {
    void queryClient.invalidateQueries({ queryKey: ["note-by-group-path", note.groupId, note.slug] });
  } else {
    void queryClient.invalidateQueries({ queryKey: ["note-by-path", note.ownerHandle, note.slug] });
  }
}

export function patchNotesListLastEdited(
  queryClient: QueryClient,
  id: string,
  lastEdited: LastEditedDto | null,
): void {
  const list = queryClient.getQueryData<NoteDto[]>(["notes"]);
  if (list === undefined) return;
  const row = list.find((n) => n.id === id);
  if (row === undefined) return;
  const prev = row.lastEdited;
  const same =
    prev === null || lastEdited === null
      ? prev === lastEdited
      : prev.at === lastEdited.at && prev.byHandle === lastEdited.byHandle && prev.agentLabel === lastEdited.agentLabel;
  if (same) return;
  // Only move forward: the list may already hold a newer value (e.g. refetched on window focus).
  if (prev !== null && (lastEdited === null || Date.parse(lastEdited.at) < Date.parse(prev.at))) return;
  queryClient.setQueryData<NoteDto[]>(
    ["notes"],
    list.map((n) => (n.id === id ? { ...n, lastEdited } : n)),
  );
}

export function useNotes(): UseQueryResult<NoteDto[]> {
  return useQuery({
    queryKey: ["notes"],
    queryFn: () => api<NoteDto[]>("/api/notes"),
  });
}

/** `retry` is set only when given: an explicit `undefined` would override the QueryClient default and query-core
 * would fall back to 3 retries. */
export interface NoteQueryOptions {
  enabled?: boolean;
  retry?: UseQueryOptions<NoteDto>["retry"];
}

function retryOption(options: NoteQueryOptions): Pick<UseQueryOptions<NoteDto>, "retry"> {
  return options.retry === undefined ? {} : { retry: options.retry };
}

/** Never add `placeholderData`/`keepPreviousData`: NotePage's seed effect assumes `data` belongs to the current ref;
 * a placeholder would seed the previous note under the new URL, and no test would fail. */
export function useNote(ref: string, options: NoteQueryOptions = {}): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note", ref],
    queryFn: () => api<NoteDto>(`/api/notes/${encodeURIComponent(ref)}`),
    enabled: (options.enabled ?? true) && ref.length > 0,
    ...retryOption(options),
  });
}

/** Same `placeholderData` ban as `useNote` (same seed effect). */
export function useNoteByPath(
  handle: string,
  slug: string,
  options: NoteQueryOptions = {},
): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note-by-path", handle, slug],
    queryFn: () => api<NoteDto>(`/api/notes/by-path/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`),
    enabled: (options.enabled ?? true) && handle.length > 0 && slug.length > 0,
    ...retryOption(options),
  });
}

/** Same `placeholderData` ban as `useNote` (same seed effect). */
export function useNoteByGroupPath(
  groupId: string,
  slug: string,
  options: NoteQueryOptions = {},
): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note-by-group-path", groupId, slug],
    queryFn: () =>
      api<NoteDto>(`/api/notes/by-group-path/${encodeURIComponent(groupId)}/${encodeURIComponent(slug)}`),
    enabled: (options.enabled ?? true) && groupId.length > 0 && slug.length > 0,
    ...retryOption(options),
  });
}

export function useBacklinks(noteId: string | undefined): UseQueryResult<BacklinkDto[]> {
  return useQuery({
    queryKey: ["backlinks", noteId],
    queryFn: async () => {
      const { backlinks } = await api<{ backlinks: BacklinkDto[] }>(
        `/api/notes/${encodeURIComponent(noteId!)}/backlinks`,
      );
      return backlinks;
    },
    enabled: !!noteId,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: { title?: string; groupId?: string; folderId?: string }) =>
      api<NoteDto>("/api/notes", {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["note", id] });
      // All backlinks: the sidebar can delete B while A is open, and A's chip for B must disappear.
      void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
      // Deleting moves the note to the trash.
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; title?: string; slug?: string | null }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["note", variables.id] });
      if (data?.id && data.id !== variables.id) {
        void queryClient.invalidateQueries({ queryKey: ["note", data.id] });
      }
    },
  });
}
