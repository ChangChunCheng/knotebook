import { AVATAR_DISPLAY_SIZE, MAX_AVATAR_DISPLAY_BYTES, type AvatarCropDto } from "@knotebook/shared";

// Separate chunk, loaded only via dynamic import(): the server does no image processing.
// `deps` exists for tests, since jsdom has no canvas.

/** `name` is a string literal because the main-bundle check uses it as a marker (class names get minified). */
export class AvatarImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarImageError";
  }
}

export interface EncodeDeps {
  createCanvas(): HTMLCanvasElement;
}

const browserDeps: EncodeDeps = {
  createCanvas: () => document.createElement("canvas"),
};

const QUALITY = 0.9;

/** Orients per EXIF; crop coordinates refer to the oriented image. The caller must `bitmap.close()`. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new AvatarImageError("cannot decode image");
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, QUALITY));
}

// Without WebP encoding, toBlob silently returns PNG; then redraw on white (JPEG has no alpha) and encode JPEG.
// Doesn't close `bitmap`; the caller does.
export async function renderDisplay(bitmap: ImageBitmap, crop: AvatarCropDto, deps: EncodeDeps = browserDeps): Promise<Blob> {
  const canvas = deps.createCanvas();
  canvas.width = AVATAR_DISPLAY_SIZE;
  canvas.height = AVATAR_DISPLAY_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new AvatarImageError("no 2d canvas context");
  ctx.imageSmoothingQuality = "high";
  const draw = () => ctx.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
  draw();
  let blob = await toBlob(canvas, "image/webp");
  if (blob === null || blob.type !== "image/webp") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    draw();
    blob = await toBlob(canvas, "image/jpeg");
    if (blob === null || blob.type !== "image/jpeg") throw new AvatarImageError("cannot encode image");
  }
  if (blob.size > MAX_AVATAR_DISPLAY_BYTES) throw new AvatarImageError("encoded image too large");
  return blob;
}
