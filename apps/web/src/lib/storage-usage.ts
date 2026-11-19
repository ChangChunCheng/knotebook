/**
 * Reached = usage >= limit (at exactly the limit no attachment > 0 bytes fits). Deliberately differs from the server's
 * `overQuotaCount` (`>`), which the plan table column follows.
 */
export function isQuotaReached(u: { usedBytes: number; quotaBytes: number | null }): boolean {
  return u.quotaBytes !== null && u.usedBytes >= u.quotaBytes;
}
