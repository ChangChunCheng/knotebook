import { STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES } from "@knotebook/shared";

/** Same rules as the server's `routes/admin-storage.ts`, except NUL and lone surrogates (left to the server's invalid_name). */
export function validPlanName(raw: string): string | null {
  const name = raw.trim();
  const n = [...name].length;
  return n >= 1 && n <= STORAGE_PLAN_NAME_MAX ? name : null;
}

export type QuotaUnit = "MB" | "GB";
const UNIT_BYTES: Record<QuotaUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 };

export function quotaBytesFromInput(raw: string, unit: QuotaUnit): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const bytes = Math.round(Number(s) * UNIT_BYTES[unit]);
  if (!Number.isSafeInteger(bytes) || bytes > STORAGE_QUOTA_MAX_BYTES) return null;
  return bytes;
}

export function quotaInputFromBytes(bytes: number): { value: string; unit: QuotaUnit } {
  if (bytes > 0 && bytes % UNIT_BYTES.GB === 0) return { value: String(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { value: String(Number((bytes / UNIT_BYTES.MB).toFixed(6))), unit: "MB" };
}
