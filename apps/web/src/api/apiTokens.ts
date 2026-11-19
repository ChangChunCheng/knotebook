import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ApiTokenDto, CreatedApiTokenDto, TokenScope } from "@knotebook/shared";
import { api } from "./client";

export const API_TOKENS_QUERY_KEY = ["api-tokens"] as const;

export function useApiTokens(): UseQueryResult<ApiTokenDto[]> {
  return useQuery({
    queryKey: API_TOKENS_QUERY_KEY,
    queryFn: () => api<{ tokens: ApiTokenDto[] }>("/api/auth/tokens").then(body => body.tokens),
  });
}

export interface CreateApiTokenInput {
  name: string;
  scope: TokenScope;
  expiresInDays: 30 | 90 | 365 | null;
}

/** The plaintext `token` is in this response only; the caller must show it. The query cache never holds it (the list is always refetched). */
export function useCreateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiTokenInput) =>
      api<CreatedApiTokenDto>("/api/auth/tokens", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}

/** `agentLabel: null` clears the column; the response then carries the label derived from the name, not "". */
export interface UpdateApiTokenPatch {
  agentLabel?: string | null;
  scope?: TokenScope;
}

export function useUpdateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateApiTokenPatch }) =>
      api<ApiTokenDto>(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    // Write the response into the cache before refetching so the old value doesn't flash meanwhile.
    onSuccess: updated => {
      queryClient.setQueryData<ApiTokenDto[]>(API_TOKENS_QUERY_KEY, rows => rows?.map(r => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}
