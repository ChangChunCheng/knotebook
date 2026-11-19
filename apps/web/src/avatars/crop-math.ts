import type { AvatarCropDto } from "@knotebook/shared";

// Original pixel p shows at viewport position `offset + p * scale`; a valid offset is ≤ 0 on both axes, so the
// image covers the viewport. Crops are integer squares in original pixels.

export interface Point {
  x: number;
  y: number;
}

export interface CropView {
  scale: number;
  offset: Point;
}

/** Max viewport px per original px. */
const MAX_PIXEL_ZOOM = 4;
/** Max scale as a multiple of minScale. */
const MAX_ZOOM_RATIO = 8;

function assertSize(width: number, height: number): void {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`invalid image size ${width}×${height}`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`invalid ${name} ${value}`);
  }
}

/** `+ 0` turns the -0 that Math.min/max can produce into 0, so equality checks don't trip. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value)) + 0;
}

export function minScale(width: number, height: number, viewport: number): number {
  assertSize(width, height);
  assertPositive("viewport", viewport);
  return viewport / Math.min(width, height);
}

export function maxScale(width: number, height: number, viewport: number): number {
  const lo = minScale(width, height, viewport);
  return Math.max(lo, Math.min(MAX_PIXEL_ZOOM, MAX_ZOOM_RATIO * lo));
}

export function clampOffset(offset: Point, scale: number, width: number, height: number, viewport: number): Point {
  return {
    x: clamp(offset.x, Math.min(0, viewport - width * scale), 0),
    y: clamp(offset.y, Math.min(0, viewport - height * scale), 0),
  };
}

export function zoomAround(view: CropView, nextScale: number, anchor: Point, width: number, height: number, viewport: number): CropView {
  assertPositive("scale", view.scale);
  assertPositive("scale", nextScale);
  const scale = clamp(nextScale, minScale(width, height, viewport), maxScale(width, height, viewport));
  const imageX = (anchor.x - view.offset.x) / view.scale;
  const imageY = (anchor.y - view.offset.y) / view.scale;
  const offset = clampOffset({ x: anchor.x - imageX * scale, y: anchor.y - imageY * scale }, scale, width, height, viewport);
  return { scale, offset };
}

/** The crop has size ≥ 1 and lies inside the image even if `offset` wasn't clamped. */
export function viewToCrop(view: CropView, width: number, height: number, viewport: number): AvatarCropDto {
  assertSize(width, height);
  assertPositive("viewport", viewport);
  assertPositive("scale", view.scale);
  const size = clamp(Math.round(viewport / view.scale), 1, Math.min(width, height));
  return {
    x: clamp(Math.round(-view.offset.x / view.scale), 0, width - size),
    y: clamp(Math.round(-view.offset.y / view.scale), 0, height - size),
    size,
  };
}

export function cropToView(crop: AvatarCropDto, width: number, height: number, viewport: number): CropView {
  const scale = clamp(viewport / Math.max(1, crop.size), minScale(width, height, viewport), maxScale(width, height, viewport));
  return { scale, offset: clampOffset({ x: -crop.x * scale, y: -crop.y * scale }, scale, width, height, viewport) };
}

export function centeredCrop(width: number, height: number): AvatarCropDto {
  assertSize(width, height);
  const size = Math.min(width, height);
  return { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), size };
}
