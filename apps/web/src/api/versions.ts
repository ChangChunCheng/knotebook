import {
  useInfiniteQuery,
  type InfiniteData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ApplyVersionBody,
  ApplyVersionResultDto,
  SavedVersionDto,
  VersionCurrentDto,
  VersionDto,
  VersionKind,
  VersionListDto,
  VersionSnapshotDto,
} from "@knotebook/shared";
import { api } from "./client";

export const VERSIONS_PAGE_SIZE = 50;

/** The server also accepts "auto"; the UI doesn't offer it. */
export type VersionKindFilter = "all" | "manual";

/** Under `['notes']` so any `['notes']` invalidation refetches the version lists (a move clears versions unless history is kept). */
export function versionsKey(noteId: string) {
  return ["notes", noteId, "versions"] as const;
}

export function versionListKey(noteId: string, kind: VersionKindFilter) {
  return [...versionsKey(noteId), "list", kind] as const;
}

export function versionCurrentKey(noteId: string) {
  return ["notes", noteId, "versions", "current"] as const;
}

/** Separate prefix keyed by id, not seq (a move that doesn't keep history renumbers seqs): an id's content never changes, so snapshots use
 * `staleTime: Infinity` and sit outside the `['notes']` prefix. */
export function versionSnapshotKey(noteId: string, id: string) {
  return ["note-versions", noteId, id] as const;
}

/** `seq` fetches the snapshot; `id` detects a renumbered seq (a move that doesn't keep history); `name` is the name at selection time (shown when the list lacks it). */
export type VersionTarget = { seq: number; id: string; name: string | null };

/** The snapshot's id differs from the list row (versions were renumbered by a move that didn't keep history): discard, don't cache. */
export class VersionSnapshotMismatch extends Error {
  constructor() {
    super("version snapshot id mismatch");
    this.name = "VersionSnapshotMismatch";
  }
}

const base = (noteId: string) => `/api/notes/${encodeURIComponent(noteId)}/versions`;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function fetchVersionList(noteId: string, opts: { before?: number; limit?: number; kind?: VersionKind } = {}): Promise<VersionListDto> {
  const params = new URLSearchParams();
  if (opts.kind !== undefined) params.set("kind", opts.kind);
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return api<VersionListDto>(qs ? `${base(noteId)}?${qs}` : base(noteId));
}

export async function fetchVersionSnapshot(noteId: string, target: VersionTarget): Promise<Uint8Array> {
  const res = await api<VersionSnapshotDto>(`${base(noteId)}/${target.seq}`);
  if (res.id !== target.id) throw new VersionSnapshotMismatch();
  return base64ToBytes(res.ydoc);
}

export function saveVersion(noteId: string, name: string | null): Promise<SavedVersionDto> {
  const trimmed = name?.trim() ?? "";
  return api<SavedVersionDto>(base(noteId), {
    method: "POST",
    body: JSON.stringify(trimmed === "" ? {} : { name: trimmed }),
  });
}

export function applyVersion(noteId: string, seq: number, body: ApplyVersionBody): Promise<ApplyVersionResultDto> {
  return api<ApplyVersionResultDto>(`${base(noteId)}/${seq}/apply`, { method: "POST", body: JSON.stringify(body) });
}

export function renameVersion(noteId: string, seq: number, name: string | null): Promise<VersionDto> {
  const trimmed = name?.trim() ?? "";
  return api<VersionDto>(`${base(noteId)}/${seq}`, {
    method: "PATCH",
    body: JSON.stringify({ name: trimmed === "" ? null : trimmed }),
  });
}

export function deleteVersion(noteId: string, seq: number): Promise<void> {
  return api<void>(`${base(noteId)}/${seq}`, { method: "DELETE" });
}

/** Always refetched before Apply: staleTime 0 makes fetchQuery hit the server. */
export function fetchCurrent(queryClient: QueryClient, noteId: string): Promise<VersionCurrentDto> {
  return queryClient.fetchQuery({
    queryKey: versionCurrentKey(noteId),
    queryFn: () => fetchVersionList(noteId, { limit: 1 }).then((r) => r.current),
    staleTime: 0,
  });
}

/** Pass `useVersions().kindFilter` so panel, page and compare share one cache. */
export function useVersionList(noteId: string, enabled: boolean, filter: VersionKindFilter = "all") {
  return useInfiniteQuery({
    queryKey: versionListKey(noteId, filter),
    queryFn: ({ pageParam }) =>
      fetchVersionList(noteId, { before: pageParam, limit: VERSIONS_PAGE_SIZE, ...(filter === "manual" ? { kind: "manual" as const } : {}) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: enabled && noteId.length > 0,
  });
}

/** Right after a filter switch, fall back to the other filter's cached `current` (filter-independent) so the subtitle and
 * save button stay steady. Not `keepPreviousData`: it would show the other filter's rows. */
export function useVersionCurrent(
  noteId: string,
  list: { data: InfiniteData<VersionListDto> | undefined; isError: boolean },
  filter: VersionKindFilter,
): VersionCurrentDto | undefined {
  const queryClient = useQueryClient();
  const own = list.data?.pages[0]?.current;
  if (own !== undefined) return own;
  // No fallback when our own query failed: the other copy may be stale.
  if (list.isError) return undefined;
  const other: VersionKindFilter = filter === "all" ? "manual" : "all";
  return queryClient.getQueryData<InfiniteData<VersionListDto>>(versionListKey(noteId, other))?.pages[0]?.current;
}

export function useVersionSnapshot(noteId: string, target: VersionTarget | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: versionSnapshotKey(noteId, target?.id ?? ""),
    queryFn: async () => {
      try {
        return await fetchVersionSnapshot(noteId, target!);
      } catch (err) {
        if (err instanceof VersionSnapshotMismatch) {
          void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
        }
        throw err;
      }
    },
    enabled: target !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export function useSaveVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string | null) => saveVersion(noteId, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}

export function useApplyVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, discardUnsaved }: { version: VersionDto; discardUnsaved: boolean }) =>
      applyVersion(noteId, version.seq, { versionId: version.id, discardUnsaved }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
      void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
    },
  });
}

export function useRenameVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ seq, name }: { seq: number; name: string | null }) => renameVersion(noteId, seq, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}

export function useDeleteVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) => deleteVersion(noteId, seq),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}
