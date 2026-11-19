import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { sealCookieJson, unsealCookieJson } from "./sealed-cookie.js";
import { OIDC_STATE_COOKIE_PATH } from "./oidc-state.js";

// One per browser: a new confirm_link overwrites the old one (the two-tab case relies on `pendingId`).

export const OIDC_PENDING_COOKIE = "knotebook_oidc_link";
export const OIDC_PENDING_TTL_SECONDS = 900;
/** Browsers silently DROP cookies over about 4096 bytes; measured on `name=value`, 3800 leaves margin. */
export const OIDC_PENDING_MAX_COOKIE_BYTES = 3800;
const NAMESPACE = "oidc-pending-link";

export interface PendingLinkPayload {
  pendingId: string;
  issuer: string;
  sub: string;
  providerId: string;
  userId: string;
  email: string;
  exp: number;
  next?: string;
}

export function newPendingId(): string {
  return randomBytes(16).toString("base64url");
}

export function sealPendingLink(appSecret: string, payload: PendingLinkPayload): string {
  return sealCookieJson(appSecret, NAMESPACE, payload);
}

export function unsealPendingLink(appSecret: string, sealed: string, nowEpochSeconds: number): PendingLinkPayload | null {
  const parsed = unsealCookieJson(appSecret, NAMESPACE, sealed);
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  for (const key of ["pendingId", "issuer", "sub", "providerId", "userId", "email"] as const) {
    if (typeof p[key] !== "string") return null;
  }
  if (typeof p.exp !== "number") return null;
  if (p.next !== undefined && typeof p.next !== "string") return null;
  if (p.exp <= nowEpochSeconds) return null;
  return parsed as PendingLinkPayload;
}

export function pendingCookieBytes(sealed: string): number {
  return Buffer.byteLength(`${OIDC_PENDING_COOKIE}=${sealed}`, "utf8");
}

/**
 * Over 3800 bytes after sealing, `next` is dropped and the cookie resealed (linking then lands on `/`). Every other field is capped
 * (issuer <= 512, sub <= 255, email <= 254; the callback rejects longer), worst case about 1671 bytes. Still over (defence in depth:
 * JSON escaping can inflate non-ASCII) gives null: the caller doesn't seal, warns and redirects to `oidc_claim_too_long`.
 */
export function sealPendingLinkWithinLimit(appSecret: string, payload: PendingLinkPayload): { sealed: string; droppedNext: boolean } | null {
  const full = sealPendingLink(appSecret, payload);
  if (pendingCookieBytes(full) <= OIDC_PENDING_MAX_COOKIE_BYTES) return { sealed: full, droppedNext: false };
  const withoutNext: PendingLinkPayload = { ...payload };
  delete withoutNext.next;
  const trimmed = sealPendingLink(appSecret, withoutNext);
  if (pendingCookieBytes(trimmed) <= OIDC_PENDING_MAX_COOKIE_BYTES) return { sealed: trimmed, droppedNext: true };
  return null;
}

export function setPendingCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">, sealed: string): void {
  reply.setCookie(OIDC_PENDING_COOKIE, sealed, {
    httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: OIDC_STATE_COOKIE_PATH, maxAge: OIDC_PENDING_TTL_SECONDS,
  });
}

/** Needs the same path/sameSite/secure as `setCookie`, or the browser doesn't treat it as the same cookie. */
export function clearPendingCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">): void {
  reply.clearCookie(OIDC_PENDING_COOKIE, { path: OIDC_STATE_COOKIE_PATH, sameSite: "lax", secure: config.cookieSecure });
}

export function readPendingLink(request: FastifyRequest, appSecret: string): PendingLinkPayload | null {
  const raw = request.cookies[OIDC_PENDING_COOKIE];
  return raw === undefined ? null : unsealPendingLink(appSecret, raw, Math.floor(Date.now() / 1000));
}
