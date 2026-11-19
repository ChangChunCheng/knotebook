import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AuthConfigDto } from "@knotebook/shared";
import { api } from "./client";

export const AUTH_CONFIG_QUERY_KEY = ["auth-config"] as const;

export function useAuthConfig(): UseQueryResult<AuthConfigDto> {
  return useQuery({ queryKey: AUTH_CONFIG_QUERY_KEY, queryFn: () => api<AuthConfigDto>("/api/auth/config") });
}
