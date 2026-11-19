import type { UserDto } from "@knotebook/shared";
import { api } from "./client";

/** Doesn't consume the link. The token goes only in a POST body, never in a URL or query key. */
export function inspectPasswordReset(token: string): Promise<{ email: string; expiresAt: string }> {
  return api<{ email: string; expiresAt: string }>("/api/auth/password-reset/inspect", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** On success the server also sets the session cookie. */
export function completePasswordReset(token: string, newPassword: string): Promise<UserDto> {
  return api<UserDto>("/api/auth/password-reset", { method: "POST", body: JSON.stringify({ token, newPassword }) });
}
