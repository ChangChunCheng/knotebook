import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  USER_SUGGEST_MAX_QUERY, USER_SUGGEST_MIN_QUERY, type UserDto, type UserSuggestResponse, type UserSuggestionDto,
} from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { api } from "./client";

export function fetchUserSuggestions(q: string): Promise<UserSuggestResponse> {
  return api<UserSuggestResponse>(`/api/users/suggest?q=${encodeURIComponent(q)}`);
}

/** Expects trimmed input; the bounds are the same constants as the server's zod schema. */
export function isSuggestQuery(q: string): boolean {
  return q.length >= USER_SUGGEST_MIN_QUERY && q.length <= USER_SUGGEST_MAX_QUERY;
}

/** Errors (incl. 429) just mean no suggestions. The key includes the user id because logout doesn't clear the cache;
 * it is read without subscribing since the key is recomputed on every keystroke. */
export function useUserSuggestions(q: string, enabled: boolean): UseQueryResult<UserSuggestionDto[]> {
  const userId = useQueryClient().getQueryData<UserDto | null>(SESSION_QUERY_KEY)?.id ?? null;
  return useQuery({
    queryKey: ["userSuggest", userId, q],
    queryFn: async () => (await fetchUserSuggestions(q)).users,
    enabled: enabled && isSuggestQuery(q),
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
