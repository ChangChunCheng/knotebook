import { formatBytes } from "@knotebook/shared";
import type { ApiFail } from "@/api/client";

/** Translation function taking interpolation params (i18next `t`-compatible). A caller that wraps it in a late-bound layer **must forward `opts`** (`NoteEditor.lateBoundTranslate`). */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Uses `storage.quotaDetail` only when usage and limit are both given; a `null` limit can never be exceeded, so it counts
 * as absent. Kept in a small module without editor dependencies: the settings page chunk imports it and must not pull in BlockNote.
 */
export function storageQuotaDescription(err: ApiFail, translate: Translate): string {
  const s = err.storage;
  if (s && typeof s.usedBytes === "number" && typeof s.quotaBytes === "number") {
    return translate("storage.quotaDetail", { used: formatBytes(s.usedBytes), quota: formatBytes(s.quotaBytes) });
  }
  return translate("storage.quotaFullGeneric");
}
