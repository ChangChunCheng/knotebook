import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AdminGroupDto, StoragePlanDefaultsDto, StoragePlanDto, StoragePlansResponse } from "@knotebook/shared";
import { api } from "./client";
import { ADMIN_USERS_QUERY_KEY } from "./admin";
import { ADMIN_GROUPS_QUERY_KEY, ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY, groupStorageKey } from "./storage";

/** Plan names and limits show in the user and group tables and in own usage, so plan mutations invalidate all four keys. */
export function useAdminStoragePlans(): UseQueryResult<StoragePlansResponse> {
  return useQuery({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY, queryFn: () => api<StoragePlansResponse>("/api/admin/storage-plans") });
}

export function useInvalidateStorageAdmin(): () => void {
  const queryClient = useQueryClient();
  return () => {
    for (const queryKey of [ADMIN_STORAGE_PLANS_QUERY_KEY, ADMIN_USERS_QUERY_KEY, ADMIN_GROUPS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}

export interface StoragePlanBody {
  name: string;
  quotaBytes: number | null;
}

export function useCreateStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: (body: StoragePlanBody) => api<StoragePlanDto>("/api/admin/storage-plans", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<StoragePlanBody> }) =>
      api<StoragePlanDto>(`/api/admin/storage-plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
    // Refetch on failure too: a 404 (deleted elsewhere) or 409 means the list is stale.
    onSettled: () => invalidate(),
  });
}

/** Refetch on failure too: 409 in_use / 404 mean the list is stale. */
export function useDeleteStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/storage-plans/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => invalidate(),
  });
}

export function useUpdateStorageDefaults() {
  const invalidate = useInvalidateStorageAdmin();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<StoragePlanDefaultsDto>) =>
      api<StoragePlanDefaultsDto>("/api/admin/storage-plans/defaults", { method: "PATCH", body: JSON.stringify(body) }),
    // Write the response into the cache before refetching so the dropdown doesn't flip back meanwhile.
    onSuccess: (defaults) => {
      queryClient.setQueryData<StoragePlansResponse>(ADMIN_STORAGE_PLANS_QUERY_KEY, (old) => (old ? { ...old, defaults } : old));
      invalidate();
    },
  });
}

export function useAdminGroups(): UseQueryResult<AdminGroupDto[]> {
  return useQuery({ queryKey: ADMIN_GROUPS_QUERY_KEY, queryFn: () => api<AdminGroupDto[]>("/api/admin/groups") });
}

/** Plans are refetched on failure too (404 storage_plan_not_found = plan just deleted). Group plans don't affect personal usage, so `["storage"]` is not invalidated. */
export function useAssignGroupPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, planId }: { groupId: string; planId: string }) =>
      api<AdminGroupDto>(`/api/admin/groups/${encodeURIComponent(groupId)}/storage-plan`, { method: "PATCH", body: JSON.stringify({ planId }) }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY, (rows) => rows?.map((r) => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: groupStorageKey(updated.id) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY });
    },
  });
}
