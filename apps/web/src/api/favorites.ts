import { useMemo } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { FavoriteDto } from "@knotebook/shared";
import { ApiFail, api } from "./client";

export const FAVORITES_QUERY_KEY = ["favorites"] as const;
// Adding is optimistic; removal waits for the 204 (removal is always confirmed first). Add and remove share one mutation key so
// "this note is pending" and "other toggles in flight" can both be queried.
const FAVORITE_SET_KEY = ["favorites", "set"] as const;
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

interface FavoriteVars {
  noteId: string;
}

export function useFavorites(options: { enabled?: boolean } = {}): UseQueryResult<FavoriteDto[]> {
  return useQuery({
    queryKey: FAVORITES_QUERY_KEY,
    queryFn: () => api<FavoriteDto[]>("/api/favorites"),
    enabled: options.enabled ?? true,
  });
}

/** Same order as the server's list: newest first, ties broken by the larger noteId. */
function sortFavorites(list: FavoriteDto[]): FavoriteDto[] {
  return list.sort((a, b) => {
    if (a.favoritedAt !== b.favoritedAt) return a.favoritedAt < b.favoritedAt ? 1 : -1;
    if (a.noteId === b.noteId) return 0;
    return a.noteId < b.noteId ? 1 : -1;
  });
}

function updateFavorites(queryClient: QueryClient, update: (list: FavoriteDto[]) => FavoriteDto[]): void {
  queryClient.setQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY, (old) => (old === undefined ? old : update(old)));
}

/** Refetch only when no other toggle is in flight (the settling one still counts, hence 1): a refetch
 * while A is pending returns a list without A and overwrites A's optimistic row. */
function invalidateIfLast(queryClient: QueryClient): void {
  if (queryClient.isMutating({ mutationKey: FAVORITE_SET_KEY }) === 1) {
    void queryClient.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
  }
}

export function useAddFavorite(): UseMutationResult<FavoriteDto, unknown, FavoriteVars, { inserted: boolean }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: FAVORITE_SET_KEY,
    mutationFn: ({ noteId }: FavoriteVars) => api<FavoriteDto>(`/api/favorites/${encodeURIComponent(noteId)}`, { method: "PUT" }),
    onMutate: async ({ noteId }) => {
      await queryClient.cancelQueries({ queryKey: FAVORITES_QUERY_KEY, exact: true });
      const before = queryClient.getQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY);
      const inserted = before !== undefined && !before.some((f) => f.noteId === noteId);
      if (inserted) {
        updateFavorites(queryClient, (list) => sortFavorites([...list, { noteId, favoritedAt: new Date().toISOString() }]));
      }
      return { inserted };
    },
    onError: (_err, { noteId }, context) => {
      // Undo only this note, not a full restore: a removal finished meanwhile would reappear.
      if (context?.inserted) updateFavorites(queryClient, (list) => list.filter((f) => f.noteId !== noteId));
    },
    onSuccess: (row) => {
      // Upsert, not replace in place: a refetch during the request may have dropped the optimistic row.
      updateFavorites(queryClient, (list) => sortFavorites([...list.filter((f) => f.noteId !== row.noteId), row]));
    },
    onSettled: () => invalidateIfLast(queryClient),
  });
}

export function useRemoveFavorite(): UseMutationResult<void, unknown, FavoriteVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: FAVORITE_SET_KEY,
    mutationFn: ({ noteId }: FavoriteVars) => api<void>(`/api/favorites/${encodeURIComponent(noteId)}`, { method: "DELETE" }),
    onSuccess: (_data, { noteId }) => updateFavorites(queryClient, (list) => list.filter((f) => f.noteId !== noteId)),
    onSettled: () => invalidateIfLast(queryClient),
  });
}

export function useFavoriteStatus(noteId: string): { ready: boolean; favorite: boolean; pending: boolean } {
  const query = useFavorites();
  const pendingFor = useMutationState({
    filters: {
      mutationKey: FAVORITE_SET_KEY,
      status: "pending",
      predicate: (mutation) => (mutation.state.variables as FavoriteVars | undefined)?.noteId === noteId,
    },
    select: (mutation) => mutation.mutationId,
  });
  return {
    ready: query.isSuccess,
    // Tied to ready: after a failed read the cache still holds the old list, but the entry must show "not favorite".
    favorite: query.isSuccess && (query.data?.some((f) => f.noteId === noteId) ?? false),
    pending: pendingFor.length > 0,
  };
}

/** One subscription for long lists. `ids` is empty until loaded or after an error: check `ready`, not the empty set. */
export function useFavoriteLookup(options: { enabled?: boolean } = {}): {
  ready: boolean;
  ids: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
  query: UseQueryResult<FavoriteDto[]>;
} {
  const query = useFavorites(options);
  const ids = useMemo<ReadonlySet<string>>(
    () => (query.isSuccess ? new Set(query.data.map((f) => f.noteId)) : EMPTY_IDS),
    [query.isSuccess, query.data],
  );
  const pendingList = useMutationState({
    filters: { mutationKey: FAVORITE_SET_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as FavoriteVars | undefined)?.noteId,
  });
  const pendingKey = pendingList.filter((id): id is string => id !== undefined).sort().join("\n");
  const pendingIds = useMemo<ReadonlySet<string>>(() => (pendingKey === "" ? EMPTY_IDS : new Set(pendingKey.split("\n"))), [pendingKey]);
  return { ready: query.isSuccess, ids, pendingIds, query };
}
