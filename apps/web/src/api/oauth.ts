import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { OauthRequestDto, TokenScope } from "@knotebook/shared";
import { api } from "./client";

export const OAUTH_REQUEST_QUERY_KEY = ["oauth-request"] as const;

export function useOauthRequest(req: string | null): UseQueryResult<OauthRequestDto> {
  return useQuery({
    queryKey: [...OAUTH_REQUEST_QUERY_KEY, req],
    enabled: req !== null,
    // Doesn't consume the pending request, but retrying a 410/404 is pointless.
    retry: false,
    // A load-time snapshot: the consent checkboxes are initialised once from the first data
    // (`ConsentBody` useState), so a later refetch would desync them from the derived display.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => api<OauthRequestDto>(`/api/oauth/request?req=${encodeURIComponent(req!)}`),
  });
}

export type OauthDecisionBody =
  | { req: string; decision: "deny" }
  | { req: string; decision: "allow"; scope: TokenScope };

export function useOauthDecision() {
  return useMutation({
    mutationFn: (body: OauthDecisionBody) =>
      api<{ redirectTo: string }>("/api/oauth/decision", { method: "POST", body: JSON.stringify(body) }),
  });
}
