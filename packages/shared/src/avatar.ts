export interface AvatarRef {
  id: string;
  v: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Awareness is client-reported: parse other users' `knotebook.avatar` through this before use. */
export function parseAvatarRef(x: unknown): AvatarRef | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const { id, v } = x as { id?: unknown; v?: unknown };
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
  return { id: id.toLowerCase(), v };
}

/** Doesn't validate `id` (`.`/`..` aren't encoded): pass only a UUID from parseAvatarRef or a server DTO. */
export function avatarUrl(id: string, v: number): string {
  return `/api/avatars/${encodeURIComponent(id)}?v=${v}`;
}

/** Must equal the CHECK literal on user_avatars.display_data. */
export const MAX_AVATAR_DISPLAY_BYTES = 262144;

export const AVATAR_DISPLAY_SIZE = 256;

/** 1 MiB; enforced only by the OIDC picture downloader, not stored. */
export const MAX_OIDC_AVATAR_BYTES = 1048576;

export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

/** `pending`: the owner's browser hasn't generated the display image yet, so others can't load it. */
export interface UserAvatarDto {
  id: string;
  v: number;
  pending: boolean;
}

export interface AvatarCropDto {
  x: number;
  y: number;
  size: number;
}

export interface AvatarCropUpload extends AvatarCropDto {
  width: number;
  height: number;
}

export interface AvatarCandidateDto {
  id: string;
  source: "upload" | "oidc";
  providerName: string | null;
  avatar: AvatarRef;
  pending: boolean;
  current: boolean;
  crop: AvatarCropDto | null;
  originalWidth: number | null;
  originalHeight: number | null;
  originalSize: number;
  displaySize: number;
  createdAt: string;
}

export interface AvatarListDto {
  candidates: AvatarCandidateDto[];
  auto: boolean;
  refreshable: { identityId: string; providerName: string }[];
}
