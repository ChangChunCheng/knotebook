import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { USER_SUGGEST_MAX_QUERY, USER_SUGGEST_MIN_QUERY, type UserSuggestResponse, type UserSuggestionDto } from "@knotebook/shared";
import { api } from "./client";

/** `GET /api/users/suggest?q=`：呼叫者「認識的人」（同群組成員、自己分享過的對象），不是全站名錄（見 server `routes/users.ts`）。 */
export function fetchUserSuggestions(q: string): Promise<UserSuggestResponse> {
  return api<UserSuggestResponse>(`/api/users/suggest?q=${encodeURIComponent(q)}`);
}

/** 長度合法時才發請求（2–100 字，與 server 的 zod 同一組常數）；呼叫端負責 trim 與 debounce。 */
export function isSuggestQuery(q: string): boolean {
  return q.length >= USER_SUGGEST_MIN_QUERY && q.length <= USER_SUGGEST_MAX_QUERY;
}

/**
 * 輸入框的建議清單。`keepPreviousData`：打字中下一批還沒到時沿用上一批，清單不閃。查詢失敗（含 429）就當作沒有建議——
 * 建議只是輔助，輸入完整 email 一樣送得出去，不另顯示錯誤。
 */
export function useUserSuggestions(q: string, enabled: boolean): UseQueryResult<UserSuggestionDto[]> {
  return useQuery({
    queryKey: ["userSuggest", q],
    queryFn: async () => (await fetchUserSuggestions(q)).users,
    enabled: enabled && isSuggestQuery(q),
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
