import type { UserDto } from "@knotebook/shared";
import { api } from "./client";

/** The token goes only in a POST body, never in a URL or query key. */
export function inspectInvite(token: string): Promise<{ expiresAt: string }> {
  return api<{ expiresAt: string }>("/api/auth/invite/inspect", { method: "POST", body: JSON.stringify({ token }) });
}

export function acceptInvite(body: { token: string; email: string; password: string; displayName?: string }): Promise<UserDto> {
  return api<UserDto>("/api/auth/invite/accept", { method: "POST", body: JSON.stringify(body) });
}
