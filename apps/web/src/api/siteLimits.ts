import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import type { SiteLimitsDto, SiteLimitsPatchBody } from "@knotebook/shared";
import { api } from "./client";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";

export const SITE_LIMITS_QUERY_KEY = ["admin", "site-limits"] as const;

export function useSiteLimits(): UseQueryResult<SiteLimitsDto> {
  return useQuery({ queryKey: SITE_LIMITS_QUERY_KEY, queryFn: () => api<SiteLimitsDto>("/api/admin/limits") });
}

/** Public settings (e.g. the upload size limit) change too, hence `["auth-config"]`. */
export function useUpdateSiteLimits(): UseMutationResult<SiteLimitsDto, unknown, SiteLimitsPatchBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SiteLimitsPatchBody) => api<SiteLimitsDto>("/api/admin/limits", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(SITE_LIMITS_QUERY_KEY, updated);
      // Responses to two saves can arrive out of order; refetch so the server's state wins.
      void queryClient.invalidateQueries({ queryKey: SITE_LIMITS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
    },
  });
}
