import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import type { ProviderIconDto } from "@knotebook/shared";
import type { Db } from "../../src/db/index.js";
import { authProviders } from "../../src/db/schema.js";
import { seedAuthProvider } from "./oidc-provider.js";

/** Recognizable string embedded in the test image: its presence in any list response means the image body leaked. */
export const ICON_MARKER = "KNB-ICON-MARKER";

/** PNG signature + marker + padding of total length `size` (the server only checks the header, never decodes); `size` must be at least 8 + marker length. */
export function pngBytes(size = 64): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(size - sig.length, 0x20);
  body.write(ICON_MARKER, 0, "latin1");
  return Buffer.concat([sig, body]);
}

export const TEMPLATES = ["gitlab", "google", "oidc"] as const;
export const ICON_KINDS = ["template", "gitlab", "google", "upload", "none"] as const;
export const GENERIC: ProviderIconDto = { type: "builtin", name: "generic" };

export interface IconCase {
  id: string;
  displayName: string;
  template: (typeof TEMPLATES)[number];
  kind: (typeof ICON_KINDS)[number];
  issuer: string;
  version: number;
}

/** Hand-written provider icon lookup table - deliberately not calling `resolveProviderIcon` (the code under test; calling it would be circular). */
export function expectedIcon(c: Pick<IconCase, "id" | "template" | "kind" | "version">): ProviderIconDto {
  switch (c.kind) {
    case "template":
    case "gitlab":
    case "google":
      return GENERIC;
    case "upload":
      return { type: "upload", url: `/api/auth/providers/${c.id}/icon?v=${c.version}` };
    case "none":
      return null;
  }
}

/** 15 enabled services (three templates x five kinds), sortOrder 0-14; written directly to the DB because this fixture is not under test. */
export async function seedIconMatrix(db: Db): Promise<IconCase[]> {
  const out: IconCase[] = [];
  let order = 0;
  for (const template of TEMPLATES) {
    for (const kind of ICON_KINDS) {
      const issuer = `https://icon-${template}-${kind}.example`;
      const displayName = `${template}/${kind}`;
      const p = await seedAuthProvider(db, { issuerUrl: issuer, template, displayName, sortOrder: order++ });
      const version = kind === "upload" ? 3 : 0;
      await db
        .update(authProviders)
        .set(kind === "upload" ? { iconKind: kind, iconData: pngBytes(), iconMime: "image/png", iconVersion: version } : { iconKind: kind })
        .where(eq(authProviders.id, p.id));
      out.push({ id: p.id, displayName, template, kind, issuer, version });
    }
  }
  return out;
}

/** The response body must not contain image bytes or internal column names (the list SELECT doesn't select icon_data/icon_mime). */
export function expectNoIconBytes(body: string): void {
  expect(body).not.toContain(ICON_MARKER);
  expect(body).not.toContain('"Buffer"');
  for (const key of ["iconData", "iconMime", "iconVersion", "icon_data", "icon_mime", "icon_version"]) expect(body, key).not.toContain(key);
}

export const ICON_BOUNDARY = "knotebookIconBoundary";

export interface IconPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

/** Hand-built multipart/form-data (no string round trip - the image is binary; like the file-private helper in test/uploads.test.ts). */
export function multipartBody(parts: IconPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const dispo = part.filename !== undefined ? `form-data; name="${part.name}"; filename="${part.filename}"` : `form-data; name="${part.name}"`;
    const head = [`--${ICON_BOUNDARY}`, `Content-Disposition: ${dispo}`];
    if (part.contentType !== undefined) head.push(`Content-Type: ${part.contentType}`);
    head.push("", "");
    chunks.push(Buffer.from(head.join("\r\n"), "utf-8"));
    chunks.push(typeof part.data === "string" ? Buffer.from(part.data, "utf-8") : part.data);
    chunks.push(Buffer.from("\r\n", "utf-8"));
  }
  chunks.push(Buffer.from(`--${ICON_BOUNDARY}--\r\n`, "utf-8"));
  return Buffer.concat(chunks);
}

export function iconFile(data: Buffer, opts: { filename?: string; contentType?: string } = {}): IconPart {
  return { name: "file", filename: opts.filename ?? "icon.png", contentType: opts.contentType ?? "image/png", data };
}

export function putIcon(app: FastifyInstance, id: string, body: Buffer, opts: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: "PUT",
    url: `/api/admin/auth/providers/${id}/icon`,
    payload: body,
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
    headers: { "content-type": `multipart/form-data; boundary=${ICON_BOUNDARY}`, ...opts.headers },
  });
}

/** Header samples (`uploads/magic-bytes.ts`: GIF = `GIF8` + `9`/`7` + `a`; JPEG = FF D8 FF; WebP = `RIFF` + 4 bytes + `WEBP`). */
export const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
export const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(8)]);
export const TEXT_BYTES = Buffer.from("plain text, not an image at all", "utf-8");
