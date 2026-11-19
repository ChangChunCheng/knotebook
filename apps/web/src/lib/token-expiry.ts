import type { ApiTokenDto } from "@knotebook/shared";

/** Time for the list's "expires" column (#298): PAT = the expiry chosen at creation; oauth = last use (or creation if never used) + idleDays. */
export function displayExpiry(
  token: Pick<ApiTokenDto, "kind" | "lastUsedAt" | "createdAt" | "expiresAt">,
  idleDays: number
): string | null {
  if (token.kind === "pat") return token.expiresAt;
  return new Date(Date.parse(token.lastUsedAt ?? token.createdAt) + idleDays * 86_400_000).toISOString();
}
