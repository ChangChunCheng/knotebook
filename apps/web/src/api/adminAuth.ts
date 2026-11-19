import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  AdminAuthProbeResultDto,
  AdminAuthProviderDto,
  AdminAuthProviderImpactDto,
  AdminAuthSettingsDto,
  AuthProviderTemplate,
  ProviderIconKind,
} from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";
import { api, ApiFail } from "./client";

/** All `/api/admin/auth/*` keys live under `["admin-auth"]` so one invalidate covers them. */
export const ADMIN_AUTH_PROVIDERS_QUERY_KEY = ["admin-auth", "providers"] as const;

export function useAdminAuthProviders(): UseQueryResult<AdminAuthProviderDto[]> {
  return useQuery({
    queryKey: ADMIN_AUTH_PROVIDERS_QUERY_KEY,
    queryFn: () => api<{ providers: AdminAuthProviderDto[] }>("/api/admin/auth/providers").then(body => body.providers),
  });
}

/** Refetched on every open: the counts are a snapshot. */
export function useAuthProviderImpact(id: string, enabled: boolean): UseQueryResult<AdminAuthProviderImpactDto> {
  return useQuery({
    queryKey: ["admin-auth", "impact", id],
    queryFn: () => api<AdminAuthProviderImpactDto>(`/api/admin/auth/providers/${id}/impact`),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Also refetch `auth-config` so the login page in this tab shows the new buttons after logout. */
function invalidateAdminAuth(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["admin-auth"] });
  void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
}

export interface CreateAuthProviderBody {
  template: AuthProviderTemplate;
  displayName: string;
  issuerUrl: string;
  clientId?: string;
  clientSecret?: string;
}

export interface PatchAuthProviderBody {
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  enabled?: boolean;
  sortOrder?: number;
  iconKind?: Exclude<ProviderIconKind, "upload">;
  autoCreateEnabled?: boolean;
}

export function useCreateAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAuthProviderBody) =>
      api<AdminAuthProviderDto>("/api/admin/auth/providers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

export function usePatchAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAuthProviderBody }) =>
      api<AdminAuthProviderDto>(`/api/admin/auth/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

export function useDeleteAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/auth/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

export function useUploadAuthProviderIcon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: Blob }) => {
      const form = new FormData();
      form.append("file", file, "icon.png");
      return api<AdminAuthProviderDto>(`/api/admin/auth/providers/${id}/icon`, { method: "PUT", body: form });
    },
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

/** A successful test writes `resolved_issuer` (clears the card's "not connected" hint), so invalidate. */
export function useTestAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<AdminAuthProbeResultDto>(`/api/admin/auth/providers/${id}/test`, { method: "POST" }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

/** Writes nothing, so no invalidation. */
export function useDiscoverAuthProvider() {
  return useMutation({
    mutationFn: (issuerUrl: string) =>
      api<AdminAuthProbeResultDto>("/api/admin/auth/discover", { method: "POST", body: JSON.stringify({ issuerUrl }) }),
  });
}

export const ADMIN_AUTH_SETTINGS_QUERY_KEY = ["admin-auth", "settings"] as const;

export function useAdminAuthSettings(): UseQueryResult<AdminAuthSettingsDto> {
  return useQuery({ queryKey: ADMIN_AUTH_SETTINGS_QUERY_KEY, queryFn: () => api<AdminAuthSettingsDto>("/api/admin/auth/settings") });
}

export interface PatchAdminAuthSettingsBody {
  registrationEnabled?: boolean;
  passwordLoginEnabled?: boolean;
}

/** A 409 means this page's snapshot is stale, so refetch then too (`passwordLoginImpact` must catch up). */
export function usePatchAdminAuthSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchAdminAuthSettingsBody) =>
      api<AdminAuthSettingsDto>("/api/admin/auth/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
    onError: err => {
      if (err instanceof ApiFail && err.status === 409) invalidateAdminAuth(queryClient);
    },
  });
}
