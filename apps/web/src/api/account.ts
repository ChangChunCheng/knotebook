import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { IdentitiesDto, OidcRedirectDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { api } from "./client";

export const IDENTITIES_QUERY_KEY = ["identities"] as const;

export function useIdentities(): UseQueryResult<IdentitiesDto> {
  return useQuery({ queryKey: IDENTITIES_QUERY_KEY, queryFn: () => api<IdentitiesDto>("/api/auth/identities") });
}

export function useUnlinkIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/identities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    // Refetch on failure too: a 409/404 means the list on screen is already stale.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: IDENTITIES_QUERY_KEY }),
  });
}

/** Always sends `{}`: the server rejects this POST without a body. */
export function useStartLink() {
  return useMutation({
    mutationFn: (providerId: string) =>
      api<OidcRedirectDto>(`/api/auth/oidc/link/${encodeURIComponent(providerId)}`, { method: "POST", body: "{}" }),
  });
}

export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (newPassword: string) => api<void>("/api/auth/password/set", { method: "POST", body: JSON.stringify({ newPassword }) }),
    // Refetch on 409 password_already_set too. Identities change because `unlinkable` depends on having a password.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: IDENTITIES_QUERY_KEY });
    },
  });
}
