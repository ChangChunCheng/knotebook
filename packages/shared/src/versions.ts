// "Base" (notes.version_base_seq): the version the current content continues from; null if none.
import type { AvatarRef } from "./avatar.js";

/** Code points. */
export const VERSION_NAME_MAX = 120;
export const VERSION_LIST_LIMIT_DEFAULT = 50;
export const VERSION_LIST_LIMIT_MAX = 100;
/** 1 ≤ keepAllDays ≤ dailyUntilDays ≤ this, as in DB CHECK site_settings_version_days_chk. */
export const VERSION_DAYS_MAX = 3650;
export const VERSION_KEEP_ALL_DAYS_DEFAULT = 7;
export const VERSION_DAILY_UNTIL_DAYS_DEFAULT = 30;
/** Minutes without content changes before an automatic version; same range as DB CHECK site_settings_version_auto_wait_chk. */
export const VERSION_AUTO_WAIT_MINUTES_DEFAULT = 5;
export const VERSION_AUTO_WAIT_MINUTES_MIN = 1;
export const VERSION_AUTO_WAIT_MINUTES_MAX = 60;

export type VersionKind = "auto" | "manual";

/** `handle` is current ("" if deleted); `agentLabel` is a snapshot. `avatar` is the user's own, even on AI rows. */
export interface VersionEditorDto {
  handle: string;
  agentLabel: string | null;
  avatar: AvatarRef | null;
}

export interface VersionBaseRefDto {
  id: string | null;
  name: string | null;
  deleted: boolean;
}

/** `baseSeq` is set only when the base wasn't the latest version at the time. */
export interface VersionDto {
  id: string;
  seq: number;
  kind: VersionKind;
  name: string | null;
  editors: VersionEditorDto[];
  baseSeq: number | null;
  base: VersionBaseRefDto | null;
  createdAt: string;
}

export interface VersionCurrentDto {
  baseSeq: number | null;
  base: VersionBaseRefDto | null;
  dirty: boolean;
  nextSeq: number;
  autoEnabled: boolean;
}

export interface VersionListDto {
  versions: VersionDto[];
  current: VersionCurrentDto;
  nextBefore: number | null;
}

/** `ydoc`: base64 encodeStateAsUpdate. */
export interface VersionSnapshotDto {
  id: string;
  seq: number;
  ydoc: string;
}

/** `upgraded`: content equals the base, so no row was created; the base became manual and took the name. */
export type SavedVersionDto = VersionDto & { upgraded: boolean };

export interface ApplyVersionBody {
  versionId: string;
  discardUnsaved: boolean;
}

export interface ApplyVersionResultDto {
  current: VersionCurrentDto;
}

export interface VersionSettingsDto {
  keepAllDays: number;
  dailyUntilDays: number;
  autoVersionsEnabled: boolean;
  autoWaitMinutes: number;
}

const UNSTORABLE = /\u0000|\p{Surrogate}/u;

/** Rejects NUL and lone surrogates before SQL: PostgreSQL text can't store them (22021). */
export function normalizeVersionName(raw: string | null): { ok: true; name: string | null } | { ok: false } {
  if (raw === null) return { ok: true, name: null };
  const name = raw.trim();
  if (name === "") return { ok: true, name: null };
  if (UNSTORABLE.test(name) || [...name].length > VERSION_NAME_MAX) return { ok: false };
  return { ok: true, name };
}
