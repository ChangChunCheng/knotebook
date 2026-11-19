import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { userAvatars } from "../src/db/schema.js";
import { cookieOf } from "./group-helpers.js";
import { ICON_BOUNDARY, WEBP_BYTES, multipartBody, type IconPart } from "./helpers/provider-icon.js";
import { pngOf } from "./storage-helpers.js";

export interface SeedAvatarOpts {
  userId: string;
  /** Original byte count (within the `original_size` CHECK range: 1 ~ 10 MiB). */
  originalSize: number;
  /** Display image byte count; 0 = display image not generated yet (only OIDC candidates have this state). */
  displaySize: number;
  isCurrent?: boolean;
  /** Source identity of an OIDC candidate (`displaySize` is 0). */
  identityId?: string;
}

export async function seedAvatarRow(db: Db, o: SeedAvatarOpts): Promise<string> {
  const pending = o.displaySize === 0;
  const [row] = await db
    .insert(userAvatars)
    .values({
      userId: o.userId,
      source: pending ? "oidc" : "upload",
      identityId: pending ? (o.identityId ?? null) : null,
      oidcPictureUrl: pending ? `https://idp.example.com/pic/${randomUUID()}` : null,
      originalFile: randomUUID(),
      originalSha256: randomBytes(32),
      originalMime: "image/png",
      originalSize: o.originalSize,
      displayData: pending ? null : Buffer.alloc(o.displaySize, 0x41),
      displayMime: pending ? null : "image/webp",
      displaySize: o.displaySize,
      isCurrent: o.isCurrent ?? false,
    })
    .returning({ id: userAvatars.id });
  return row!.id;
}

/** A display image of exactly `size` bytes that is detectable as WebP (`WEBP_BYTES` plus padding). */
export function webpOf(size: number): Buffer {
  if (size < WEBP_BYTES.length) throw new Error(`webpOf: size ${size} < ${WEBP_BYTES.length}`);
  return Buffer.concat([WEBP_BYTES, Buffer.alloc(size - WEBP_BYTES.length, 0x42)]);
}

export const DEFAULT_CROP = { x: 4, y: 8, size: 64, width: 128, height: 96 };

export interface AvatarUploadOpts {
  /** Original bytes; `null` = don't send this part. Default is a 2000-byte PNG. */
  original?: Buffer | null;
  /** Display image bytes; `null` = don't send this part. Default is a 300-byte WebP. */
  display?: Buffer | null;
  /** Object -> JSON string; string -> as is; `null` = don't send the `crop` field. */
  crop?: Record<string, unknown> | string | null;
  /** `null` = no cookie (not signed in). */
  cookies?: Record<string, string> | null;
  headers?: Record<string, string>;
}

export function avatarUploadBody(opts: AvatarUploadOpts = {}): Buffer {
  const parts: IconPart[] = [];
  const original = opts.original === undefined ? pngOf(2000) : opts.original;
  const display = opts.display === undefined ? webpOf(300) : opts.display;
  const crop = opts.crop === undefined ? DEFAULT_CROP : opts.crop;
  if (original !== null) parts.push({ name: "original", filename: "photo.png", contentType: "image/png", data: original });
  if (display !== null) parts.push({ name: "display", filename: "avatar.webp", contentType: "image/webp", data: display });
  if (crop !== null) parts.push({ name: "crop", data: typeof crop === "string" ? crop : JSON.stringify(crop) });
  return multipartBody(parts);
}

export async function uploadAvatar(app: FastifyInstance, userId: string, opts: AvatarUploadOpts = {}) {
  const cookies = opts.cookies === undefined ? await cookieOf(userId) : opts.cookies;
  return app.inject({
    method: "POST",
    url: "/api/auth/avatars",
    payload: avatarUploadBody(opts),
    ...(cookies !== null ? { cookies } : {}),
    headers: { "content-type": `multipart/form-data; boundary=${ICON_BOUNDARY}`, ...opts.headers },
  });
}

export interface AvatarRecropOpts {
  /** Display image bytes; `null` = don't send this part. Default is a 300-byte WebP. */
  display?: Buffer | null;
  /** Object -> JSON string; string -> as is; `null` = don't send the `crop` field. */
  crop?: Record<string, unknown> | string | null;
  /** Version sent: string as is; `null` = don't send the `version` field. Default 1. */
  version?: number | string | null;
  /** `null` = no cookie (not signed in). */
  cookies?: Record<string, string> | null;
  headers?: Record<string, string>;
}

export function avatarRecropBody(opts: AvatarRecropOpts = {}): Buffer {
  const parts: IconPart[] = [];
  const display = opts.display === undefined ? webpOf(300) : opts.display;
  const crop = opts.crop === undefined ? DEFAULT_CROP : opts.crop;
  const version = opts.version === undefined ? 1 : opts.version;
  if (display !== null) parts.push({ name: "display", filename: "avatar.webp", contentType: "image/webp", data: display });
  if (crop !== null) parts.push({ name: "crop", data: typeof crop === "string" ? crop : JSON.stringify(crop) });
  if (version !== null) parts.push({ name: "version", data: String(version) });
  return multipartBody(parts);
}

export async function recropAvatar(app: FastifyInstance, userId: string, id: string, opts: AvatarRecropOpts = {}) {
  const cookies = opts.cookies === undefined ? await cookieOf(userId) : opts.cookies;
  return app.inject({
    method: "PUT",
    url: `/api/auth/avatars/${id}/display`,
    payload: avatarRecropBody(opts),
    ...(cookies !== null ? { cookies } : {}),
    headers: { "content-type": `multipart/form-data; boundary=${ICON_BOUNDARY}`, ...opts.headers },
  });
}

/**
 * Counts queries sent to PostgreSQL while `fn` runs (spy on `pg.Client#query`, which drizzle and pool queries all end up in).
 * `match` counts only statements whose SQL text matches (e.g. only those touching `user_avatars`).
 */
export async function countQueries<T>(fn: () => Promise<T>, match?: RegExp): Promise<{ result: T; count: number }> {
  const spy = vi.spyOn(pg.Client.prototype, "query");
  try {
    const result = await fn();
    const count = spy.mock.calls.filter(([q]) => {
      if (match === undefined) return true;
      const text = typeof q === "string" ? q : (q as { text?: string } | null)?.text;
      return typeof text === "string" && match.test(text);
    }).length;
    return { result, count };
  } finally {
    spy.mockRestore();
  }
}
