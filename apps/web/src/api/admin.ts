import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AdminInviteDto, AvatarRef, SpaceStorageDto } from "@knotebook/shared";
import { api } from "./client";
import { ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY } from "./storage";

/** Mirrors `AdminUserDto` in `apps/server/src/routes/admin-users.ts`; not in shared because only admin pages read it. */
export interface AdminUserDto {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  /** null = no login since the upgrade. */
  lastLoginAt: string | null;
  /** Last session request, collab connection or edit, or login; null = never. */
  lastActiveAt: string | null;
  hasPassword: boolean;
  /** Only an unused, unrevoked, unexpired link; shown even while password login is off. */
  passwordResetExpiresAt: string | null;
  storage: SpaceStorageDto;
  /** Also null while the display image isn't ready yet. */
  avatar: AvatarRef | null;
}

export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

export function useAdminUsers(): UseQueryResult<AdminUserDto[]> {
  return useQuery({
    queryKey: ADMIN_USERS_QUERY_KEY,
    queryFn: () => api<AdminUserDto[]>("/api/admin/users"),
  });
}

export const ADMIN_INVITES_QUERY_KEY = ["admin", "invites"] as const;

export function useAdminInvites(): UseQueryResult<AdminInviteDto[]> {
  return useQuery({
    queryKey: ADMIN_INVITES_QUERY_KEY,
    queryFn: () => api<AdminInviteDto[]>("/api/admin/invites"),
  });
}

/** Invalidation isn't returned, so the one-time token shows without waiting for the list refetch.
 * `gcTime: 0` for the same reason as `useCreatePasswordReset`. */
export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ expiresInDays, label }: { expiresInDays: number; label: string }) =>
      api<{ invite: AdminInviteDto; token: string }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify(label === "" ? { expiresInDays } : { expiresInDays, label }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY });
    },
  });
}

/** Returns the invalidation so `isPending` covers the refetch (see useAdminUserAction). */
export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY }),
  });
}

/** Invalidation isn't returned, so the one-time token shows without waiting for the list refetch.
 * `gcTime: 0`: don't keep the one-time token in the mutation cache for 5 min (hygiene; same JS heap, not a security boundary). */
export function useCreatePasswordReset() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ userId, expiresInHours }: { userId: string; expiresInHours: number }) =>
      api<{ token: string; expiresAt: string }>(`/api/admin/users/${encodeURIComponent(userId)}/password-reset`, {
        method: "POST",
        body: JSON.stringify({ expiresInHours }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
  });
}

/** Returns the invalidation so `isPending` covers the refetch (see useAdminUserAction). */
export function useCancelPasswordReset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/admin/users/${encodeURIComponent(userId)}/password-reset`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
  });
}

/** No body, so `api()` adds no JSON content type (see `client.ts`): a JSON content type with an empty body
 * would get 400 `FST_ERR_CTP_EMPTY_JSON_BODY`. Returning the invalidation promise makes
 * `mutateAsync` resolve after the list refetch, so a just-changed role/toggle doesn't flip back. */
function useAdminUserAction(action: "disable" | "enable" | "promote" | "demote") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
  });
}

export function useDisableAdminUser() {
  return useAdminUserAction("disable");
}

export function useEnableAdminUser() {
  return useAdminUserAction("enable");
}

export function usePromoteAdminUser() {
  return useAdminUserAction("promote");
}

export function useDemoteAdminUser() {
  return useAdminUserAction("demote");
}

/** The response is the full row, so it replaces the cached row (the dropdown shows the new plan without waiting for a
 * refetch). Own usage is invalidated in case the admin changed their own plan. */
export function useAssignUserPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, planId }: { userId: string; planId: string }) =>
      api<AdminUserDto>(`/api/admin/users/${encodeURIComponent(userId)}/storage-plan`, { method: "PATCH", body: JSON.stringify({ planId }) }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminUserDto[]>(ADMIN_USERS_QUERY_KEY, (rows) => rows?.map((r) => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_QUERY_KEY });
    },
    // Refetch plans on failure too: 404 storage_plan_not_found means the plan was just deleted, and the dropdown must stop listing it.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY });
    },
  });
}
