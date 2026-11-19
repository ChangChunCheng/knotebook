import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AvatarCandidateDto, AvatarCropUpload, AvatarListDto, UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { notifyAvatarWritten } from "@/avatars/display-filler";
import { api, ApiFail } from "./client";
import { STORAGE_USAGE_QUERY_KEY } from "./storage";

// Image reads always use shared `avatarUrl`; never build image URLs here.

export const AVATARS_QUERY_KEY = ["avatars"] as const;

/** Refetch without a write having happened (background fill found a stale version); writes use `invalidateAvatarRelated`.
 * Storage usage is included: both the original and the display image count toward it. */
export function invalidateAvatarQueries(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: AVATARS_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: STORAGE_USAGE_QUERY_KEY }),
  ]);
}

export function invalidateAvatarRelated(qc: QueryClient): Promise<unknown> {
  // Requeue candidates whose display image failed for lack of space; there may be room now.
  notifyAvatarWritten();
  return invalidateAvatarQueries(qc);
}

/** Follows the actual format: the encoder falls back to JPEG when WebP isn't supported. */
function displayFileName(display: Blob): string {
  return display.type === "image/jpeg" ? "display.jpg" : "display.webp";
}

export function useAvatars(): UseQueryResult<AvatarListDto> {
  return useQuery({ queryKey: AVATARS_QUERY_KEY, queryFn: () => api<AvatarListDto>("/api/auth/avatars") });
}

export interface UploadAvatarInput {
  original: Blob;
  display: Blob;
  crop: AvatarCropUpload;
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ original, display, crop }: UploadAvatarInput) => {
      const form = new FormData();
      form.append("original", original, original instanceof File && original.name !== "" ? original.name : "original");
      form.append("display", display, displayFileName(display));
      form.append("crop", JSON.stringify(crop));
      return api<AvatarCandidateDto>("/api/auth/avatars", { method: "POST", body: form });
    },
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

export interface UpdateAvatarDisplayInput {
  id: string;
  display: Blob;
  crop: AvatarCropUpload;
  /** The candidate's `avatar.v` as the caller saw it; the server answers `avatar_outdated` if it isn't current. */
  version: number;
  /** Lets the background fill abort on timeout so a stuck request doesn't stall its queue. */
  signal?: AbortSignal;
}

/** Doesn't touch the cache: shared by re-crop (useUpdateAvatarDisplay) and the background fill, which each invalidate on their own. */
export function putAvatarDisplay({ id, display, crop, version, signal }: UpdateAvatarDisplayInput): Promise<AvatarCandidateDto> {
  const form = new FormData();
  form.append("display", display, displayFileName(display));
  form.append("crop", JSON.stringify(crop));
  form.append("version", String(version));
  return api<AvatarCandidateDto>(`/api/auth/avatars/${encodeURIComponent(id)}/display`, { method: "PUT", body: form, signal });
}

export function useUpdateAvatarDisplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: putAvatarDisplay,
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

export function useRefreshOidcAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api<AvatarListDto>(`/api/auth/avatars/oidc/${encodeURIComponent(identityId)}/refresh`, { method: "POST", body: "{}" }),
    onSuccess: list => {
      qc.setQueryData(AVATARS_QUERY_KEY, list);
      return invalidateAvatarRelated(qc);
    },
  });
}

/** `null` = no avatar (initials). The response is written to the session cache so the avatar switches immediately. */
export function useSelectAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string | null) =>
      api<UserDto>("/api/auth/avatar", { method: "PUT", body: JSON.stringify({ candidateId }) }),
    onSuccess: user => {
      qc.setQueryData(SESSION_QUERY_KEY, user);
      return invalidateAvatarRelated(qc);
    },
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/avatars/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

/** Not `api()`: the response is a blob, not JSON. */
export async function fetchAvatarOriginal(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/auth/avatars/${encodeURIComponent(id)}/original`, { credentials: "include", signal });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
    if (typeof error?.code === "string" && typeof error.message === "string") {
      throw new ApiFail(response.status, error.code, error.message);
    }
    throw new ApiFail(response.status, "internal", "Unexpected error response from server");
  }
  return response.blob();
}
