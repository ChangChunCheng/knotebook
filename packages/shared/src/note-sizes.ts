// Pixel range for image previewWidth and table colwidth: readers clamp, writers validate the literal.

export const SIZE_PX_MIN = 32;
export const SIZE_PX_MAX = 4000;

export function clampSizePx(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(SIZE_PX_MAX, Math.max(SIZE_PX_MIN, Math.round(n)));
}

const SIZE_RE = /^[1-9][0-9]*$/;
export function isSizePx(s: string): boolean {
  if (!SIZE_RE.test(s)) return false;
  const n = Number(s);
  return n >= SIZE_PX_MIN && n <= SIZE_PX_MAX;
}
