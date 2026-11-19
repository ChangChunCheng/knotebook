import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { api } from "./client";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/** Writes the session cache first: with only an invalidation the old name flashes until the refetch lands. The full
 * invalidation isn't returned, so the toast doesn't wait for every active query (a test pins this). The invalidation is global
 * because the handle is denormalized into NoteDto/BacklinkDto, and renames are rare. */
export function useUpdateHandle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { handle: string }) =>
      api<UserDto>("/api/auth/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, updated);
      void queryClient.invalidateQueries();
    },
  });
}

/** Sends only `displayName` so the server skips the rename transaction and quota. Otherwise same as `useUpdateHandle`:
 * display names are joined into many responses (members, version editors, shares). */
export function useUpdateDisplayName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string }) =>
      api<UserDto>("/api/auth/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, updated);
      void queryClient.invalidateQueries();
    },
  });
}
