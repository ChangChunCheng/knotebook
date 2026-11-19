/** Rules live in shared `note-schema-config.ts`; this file only defaults `base` to `window.location.href`. */
import { BLOCKED_MEDIA_URL, isAllowedEmbedUrl, isSafeMediaUrl as sharedIsSafeMediaUrl, safeMediaUrl as sharedSafeMediaUrl } from "@knotebook/shared";

export { BLOCKED_MEDIA_URL, isAllowedEmbedUrl }; // isAllowedEmbedUrl as is: strict, no base

export function isSafeMediaUrl(raw: string, base: string = window.location.href): boolean {
  return sharedIsSafeMediaUrl(raw, base);
}

export function safeMediaUrl(raw: string, base: string = window.location.href): string {
  return sharedSafeMediaUrl(raw, base);
}
