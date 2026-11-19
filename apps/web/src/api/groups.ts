import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { DeleteGroupBody, GroupDto, GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import { api } from "./client";

/** Group mutations invalidate `['groups']` (a prefix of the members/roles keys) and `['notes']`: sidebar sections depend
 * on both. Rename and role changes also invalidate the single-note keys: they don't start with `['notes']` and the
 * document doesn't change, so an open note would keep a stale `group.name` or `permissions` (e.g. after self-demotion). */
export const GROUPS_QUERY_KEY = ["groups"] as const;

export function groupMembersKey(groupId: string) {
  return ["groups", groupId, "members"] as const;
}

export function groupRolesKey(groupId: string) {
  return ["groups", groupId, "roles"] as const;
}

export function useGroups(): UseQueryResult<GroupDto[]> {
  return useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => api<GroupDto[]>("/api/groups"),
  });
}

/** `enabled` lets callers stop once they're no longer a member (the server answers 404). */
export function useGroupMembers(groupId: string, options: { enabled?: boolean } = {}): UseQueryResult<GroupMemberDto[]> {
  return useQuery({
    queryKey: groupMembersKey(groupId),
    queryFn: () => api<GroupMemberDto[]>(`/api/groups/${encodeURIComponent(groupId)}/members`),
    enabled: (options.enabled ?? true) && groupId.length > 0,
  });
}

/** Role dropdowns need role ids; in a group with no regular members, the member role's id is only available here. */
export function useGroupRoles(groupId: string): UseQueryResult<GroupRoleDto[]> {
  return useQuery({
    queryKey: groupRolesKey(groupId),
    queryFn: () => api<GroupRoleDto[]>(`/api/groups/${encodeURIComponent(groupId)}/roles`),
    enabled: groupId.length > 0,
  });
}

export function useInvalidateGroupsAndNotes() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    // Role flags decide who sees the group trash.
    void queryClient.invalidateQueries({ queryKey: ["trash"] });
    // Transfer creates folders, leaving or removal hides group folders, role changes change folder permissions.
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
    // The favorites list only returns readable notes, so regaining access needs a refetch.
    void queryClient.invalidateQueries({ queryKey: ["favorites"] });
  };
}

export function useCreateGroup() {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (body: { name: string }) => api<GroupDto>("/api/groups", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

function invalidateSingleNoteKeys(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["note"] }),
    queryClient.invalidateQueries({ queryKey: ["note-by-path"] }),
    queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] }),
  ]);
}

export function useRenameGroup() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<GroupDto>(`/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}

/** Single-note keys (an open group note refetches as personal or 404), then `['public-link']` (a transfer clears links),
 * then the lists. Not `['shares']`: neither mode creates per-user shares. Nothing awaited: open queries may 404 and retry. */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DeleteGroupBody }) =>
      api<void>(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify(body) }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["public-link"] });
      invalidate();
    },
  });
}

export function useAddMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (body: { email: string; roleId?: string }) => addGroupMember(groupId, body),
    onSuccess: invalidate,
  });
}

/** Add only, despite PUT: an existing member gets 409 already_member. Omitting `roleId` means the built-in member role.
 * Doesn't invalidate: bulk add calls it per address and invalidates once at the end. */
export function addGroupMember(groupId: string, { email, roleId }: { email: string; roleId?: string }): Promise<GroupMemberDto> {
  return api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members`, {
    method: "PUT",
    body: JSON.stringify(roleId === undefined ? { email } : { email, roleId }),
  });
}

/** Doesn't check whether `userId` is the current user: one extra refetch beats coupling to the session. */
export function useSetMemberRole(groupId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId }),
      }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}

export function useRemoveMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/** Creating a role affects nobody's access; update and delete change holders' `permissions`, so they also invalidate single-note keys. */
export function useCreateRole(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (body: { name: string; permissions: GroupRoleFlags }) =>
      api<GroupRoleDto>(`/api/groups/${encodeURIComponent(groupId)}/roles`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

/** Server is `.strict()`: a given `permissions` needs all six keys and no `read`. `onSettled` returns the refetch so
 * `isPending` spans it (role cards rely on "not pending = cache fresh"; on failure switches snap back). `onSuccess` writes
 * the response because a failed refetch still resolves without updating the cache, and the next toggle would send stale values. */
export function useUpdateRole(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, name, permissions }: { roleId: string; name?: string; permissions?: GroupRoleFlags }) =>
      api<GroupRoleDto>(`/api/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, permissions }),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<GroupRoleDto[]>(groupRolesKey(groupId), (rows) => rows?.map((row) => (row.id === updated.id ? updated : row)));
      void invalidateSingleNoteKeys(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      // Not via useInvalidateGroupsAndNotes: `['groups']` is returned from onSettled so isPending spans it.
      // edit/delete flags decide who sees the group trash.
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Group folder permissions follow the role flags.
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
      // The favorites list only returns readable notes: a role that becomes readable again needs a refetch.
      void queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY }),
  });
}

/** Holders fall back to the built-in member role. */
export function useDeleteRole(groupId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (roleId: string) =>
      api<void>(`/api/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}
