import { MAX_PROVIDER_ICON_SOURCE_BYTES, PROVIDER_ICON_SIZE } from "@knotebook/shared";

/**
 * Browser-side resize for sign-in provider icons: scale to a 128 px longest side (never upscale) and always re-encode as PNG (keeps
 * transparency). The server does no image processing (it still checks the header and 256 KB). `deps` exists only for tests (jsdom has no
 * canvas/createImageBitmap).
 */

/** For `<input accept>`; `resizeProviderIcon` also checks `file.type`. */
export const PROVIDER_ICON_ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPTED_TYPES = new Set(PROVIDER_ICON_ACCEPT.split(","));

/** Maps to i18n `admin.auth.icon.<reason>`. */
export type ProviderIconResizeFailure = "unsupportedType" | "tooLarge" | "unreadable";

export class ProviderIconResizeError extends Error {
  constructor(readonly reason: ProviderIconResizeFailure) {
    super(reason);
    this.name = "ProviderIconResizeError";
  }
}

export interface ResizeDeps {
  decode(file: File): Promise<ImageBitmap>;
  createCanvas(): HTMLCanvasElement;
}

const browserDeps: ResizeDeps = {
  decode: file => createImageBitmap(file),
  createCanvas: () => document.createElement("canvas"),
};

export function providerIconTargetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PROVIDER_ICON_SIZE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function resizeProviderIcon(file: File, deps: ResizeDeps = browserDeps): Promise<Blob> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new ProviderIconResizeError("unsupportedType");
  if (file.size > MAX_PROVIDER_ICON_SOURCE_BYTES) throw new ProviderIconResizeError("tooLarge");
  let bitmap: ImageBitmap;
  try {
    bitmap = await deps.decode(file);
  } catch {
    throw new ProviderIconResizeError("unreadable");
  }
  try {
    const { width, height } = providerIconTargetSize(bitmap.width, bitmap.height);
    const canvas = deps.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new ProviderIconResizeError("unreadable");
    ctx.imageSmoothingQuality = "high";
    // No background fill: keeps transparency.
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new ProviderIconResizeError("unreadable");
    return blob;
  } finally {
    bitmap.close();
  }
}
