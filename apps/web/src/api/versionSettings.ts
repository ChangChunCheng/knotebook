import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupDto, UserDto, VersionSettingsDto } from "@knotebook/shared";
import { api } from "./client";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";
import { GROUPS_QUERY_KEY } from "./groups";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/** Changing the master switch invalidates the public `['auth-config']`, which non-admins read. */
export const VERSION_SETTINGS_QUERY_KEY = ["admin", "version-settings"] as const;

export function useVersionSettings() {
  return useQuery({ queryKey: VERSION_SETTINGS_QUERY_KEY, queryFn: () => api<VersionSettingsDto>("/api/admin/versions/settings") });
}

export function useUpdateVersionSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<VersionSettingsDto>) =>
      api<VersionSettingsDto>("/api/admin/versions/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(VERSION_SETTINGS_QUERY_KEY, updated);
      void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
    },
  });
}

/** Sends only `autoVersions` so the server skips the rename transaction and quota. */
export function useUpdateAutoVersions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoVersions: boolean) =>
      api<UserDto>("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ autoVersions }) }),
    onSuccess: (updated) => queryClient.setQueryData(SESSION_QUERY_KEY, updated),
  });
}

export function useUpdateGroupAutoVersions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, autoVersions }: { groupId: string; autoVersions: boolean }) =>
      api<GroupDto>(`/api/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ autoVersions }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY }),
  });
}
