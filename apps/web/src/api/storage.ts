import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { GroupStorageUsageDto, StorageUsageDto } from "@knotebook/shared";
import { api } from "./client";

/** All storage keys live here so `admin.ts` and `adminStorage.ts` don't import each other.
 * Group usage sits under `["groups"]`, so group mutations' invalidation covers it. */
export const STORAGE_USAGE_QUERY_KEY = ["storage"] as const;
export const ADMIN_STORAGE_PLANS_QUERY_KEY = ["admin", "storage-plans"] as const;
export const ADMIN_GROUPS_QUERY_KEY = ["admin", "groups"] as const;

export function groupStorageKey(groupId: string) {
  return ["groups", groupId, "storage"] as const;
}

export function useStorageUsage(): UseQueryResult<StorageUsageDto> {
  return useQuery({ queryKey: STORAGE_USAGE_QUERY_KEY, queryFn: () => api<StorageUsageDto>("/api/storage") });
}

export function useGroupStorageUsage(groupId: string): UseQueryResult<GroupStorageUsageDto> {
  return useQuery({
    queryKey: groupStorageKey(groupId),
    queryFn: () => api<GroupStorageUsageDto>(`/api/groups/${encodeURIComponent(groupId)}/storage`),
  });
}
