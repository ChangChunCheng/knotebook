import { describe, expect, it } from "vitest";
import { centeredCrop, clampOffset, cropToView, maxScale, minScale, viewToCrop, zoomAround } from "./crop-math";

const V = 280;

describe("minScale", () => {
  it("short side exactly fills the viewport: landscape, portrait, square", () => {
    expect(minScale(4000, 3000, V)).toBeCloseTo(V / 3000, 10);
    expect(minScale(3000, 4000, V)).toBeCloseTo(V / 3000, 10);
    expect(minScale(1000, 1000, V)).toBeCloseTo(V / 1000, 10);
  });
  it("holds for very narrow, very wide and 1x1", () => {
    expect(minScale(5000, 1, V)).toBe(V);
    expect(minScale(1, 5000, V)).toBe(V);
    expect(minScale(1, 1, V)).toBe(V);
  });
  it("size not a positive finite number -> throws RangeError", () => {
    expect(() => minScale(0, 100, V)).toThrow(RangeError);
    expect(() => minScale(100, Number.NaN, V)).toThrow(RangeError);
    expect(() => minScale(100, -5, V)).toThrow(RangeError);
  });
});

describe("maxScale", () => {
  it("takes the smaller of \"1 source px per 4 viewport px\" and \"8x the minimum scale\"", () => {
    // minScale = 280/3000, so 8x is about 0.747, less than 4.
    expect(maxScale(4000, 3000, V)).toBeCloseTo(8 * (V / 3000), 10);
    // minScale = 2.8, so 8x = 22.4, greater than 4.
    expect(maxScale(100, 100, V)).toBe(4);
  });
  it("never below the minimum scale (when the source is much smaller than the viewport)", () => {
    expect(maxScale(1, 1, V)).toBe(minScale(1, 1, V));
    expect(maxScale(50, 90, V)).toBeGreaterThanOrEqual(minScale(50, 90, V));
  });
});

describe("clampOffset", () => {
  const scale = 0.2; // 4000x3000 -> 800x600, larger than the 280 viewport
  it("clamped to [viewport - image size, 0] in all four directions", () => {
    expect(clampOffset({ x: 50, y: 50 }, scale, 4000, 3000, V)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: -9999, y: -9999 }, scale, 4000, 3000, V)).toEqual({ x: V - 800, y: V - 600 });
    expect(clampOffset({ x: -100, y: -100 }, scale, 4000, 3000, V)).toEqual({ x: -100, y: -100 });
  });
  it("clamp again after scaling: an offset that was valid becomes out of bounds after shrinking", () => {
    const before = clampOffset({ x: -500, y: -300 }, scale, 4000, 3000, V);
    expect(before).toEqual({ x: -500, y: -300 });
    expect(clampOffset(before, 0.1, 4000, 3000, V)).toEqual({ x: V - 400, y: V - 300 });
  });
  it("image smaller than the viewport on an axis (shouldn't happen): doesn't throw, snaps to 0", () => {
    expect(clampOffset({ x: -10, y: 30 }, 0.01, 100, 100, V)).toEqual({ x: 0, y: 0 });
  });
});

describe("zoomAround", () => {
  const w = 4000;
  const h = 3000;
  const lo = minScale(w, h, V);
  const start = { scale: lo, offset: { x: -((w * lo - V) / 2), y: 0 } };
  it("the source coordinate under the anchor is unchanged before and after zoom", () => {
    const anchor = { x: 100, y: 200 };
    const next = zoomAround(start, 0.4, anchor, w, h, V);
    const before = { x: (anchor.x - start.offset.x) / start.scale, y: (anchor.y - start.offset.y) / start.scale };
    const after = { x: (anchor.x - next.offset.x) / next.scale, y: (anchor.y - next.offset.y) / next.scale };
    expect(next.scale).toBe(0.4);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it("scale clamped to the limits", () => {
    const anchor = { x: V / 2, y: V / 2 };
    expect(zoomAround(start, 0.0001, anchor, w, h, V).scale).toBe(minScale(w, h, V));
    expect(zoomAround(start, 999, anchor, w, h, V).scale).toBe(maxScale(w, h, V));
  });
  it("resulting offset is already clamped inside the image", () => {
    const next = zoomAround(start, 0.5, { x: 0, y: 0 }, w, h, V);
    expect(next.offset).toEqual(clampOffset(next.offset, next.scale, w, h, V));
    const out = zoomAround({ scale: 0.5, offset: { x: -1000, y: -700 } }, lo, { x: V, y: V }, w, h, V);
    expect(out.offset).toEqual(clampOffset(out.offset, out.scale, w, h, V));
  });
});

describe("viewToCrop", () => {
  it("outputs integers, size > 0, inside the image", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [1234, 1234], [5000, 1], [1, 1], [97, 1013]] as const) {
      const lo = minScale(w, h, V);
      const hi = maxScale(w, h, V);
      for (const f of [0, 0.37, 0.5, 1]) {
        const scale = lo + (hi - lo) * f;
        for (const off of [{ x: 0, y: 0 }, { x: -1e9, y: -1e9 }, { x: -33.3, y: -71.9 }]) {
          const c = viewToCrop({ scale, offset: clampOffset(off, scale, w, h, V) }, w, h, V);
          expect(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.size)).toBe(true);
          expect(c.size).toBeGreaterThan(0);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.size).toBeLessThanOrEqual(w);
          expect(c.y + c.size).toBeLessThanOrEqual(h);
        }
      }
    }
  });
  it("minimum scale centered -> the whole short side", () => {
    const scale = minScale(4000, 3000, V);
    const offset = { x: -((4000 * scale - V) / 2), y: 0 };
    expect(viewToCrop({ scale, offset }, 4000, 3000, V)).toEqual({ x: 500, y: 0, size: 3000 });
  });
  it("non-integer scale/offset are rounded to integer pixels", () => {
    // size = 280 / 0.3 = 933.33..., x = 33.3 / 0.3 = 111
    expect(viewToCrop({ scale: 0.3, offset: { x: -33.3, y: -10.2 } }, 4000, 3000, V)).toEqual({ x: 111, y: 34, size: 933 });
  });
  it("1x1 -> { 0, 0, 1 }", () => {
    expect(viewToCrop({ scale: V, offset: { x: 0, y: 0 } }, 1, 1, V)).toEqual({ x: 0, y: 0, size: 1 });
  });
  it("an unclamped offset is also clamped inside the image", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [97, 1013], [1, 1]] as const) {
      for (const scale of [minScale(w, h, V), maxScale(w, h, V)]) {
        for (const offset of [{ x: -1e9, y: -1e9 }, { x: 1e9, y: 1e9 }]) {
          const c = viewToCrop({ scale, offset }, w, h, V);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.size).toBeLessThanOrEqual(w);
          expect(c.y + c.size).toBeLessThanOrEqual(h);
        }
      }
    }
  });
  it("viewport or scale not a positive finite number -> RangeError", () => {
    const ok = { scale: 0.5, offset: { x: 0, y: 0 } };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => viewToCrop(ok, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => viewToCrop({ ...ok, scale: bad }, 4000, 3000, V)).toThrow(RangeError);
      expect(() => minScale(4000, 3000, bad)).toThrow(RangeError);
      expect(() => maxScale(4000, 3000, bad)).toThrow(RangeError);
      expect(() => cropToView({ x: 0, y: 0, size: 100 }, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => zoomAround(ok, 1, { x: 0, y: 0 }, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => zoomAround({ ...ok, scale: bad }, 1, { x: 0, y: 0 }, 4000, 3000, V)).toThrow(RangeError);
      expect(() => zoomAround(ok, bad, { x: 0, y: 0 }, 4000, 3000, V)).toThrow(RangeError);
    }
  });
  it("scale slightly below the minimum (floating-point error) making size exceed the short side is still clamped into the image", () => {
    const c = viewToCrop({ scale: minScale(4000, 3000, V) * 0.9999, offset: { x: 0, y: 0 } }, 4000, 3000, V);
    expect(c.size).toBeLessThanOrEqual(3000);
    expect(c.x + c.size).toBeLessThanOrEqual(4000);
  });
});

describe("cropToView", () => {
  it("round trip with viewToCrop: error <= 1 px", () => {
    const w = 4000;
    const h = 3000;
    for (const crop of [{ x: 500, y: 0, size: 3000 }, { x: 1234, y: 567, size: 800 }, { x: 3500, y: 2600, size: 400 }, { x: 0, y: 0, size: 3000 }]) {
      const back = viewToCrop(cropToView(crop, w, h, V), w, h, V);
      expect(Math.abs(back.x - crop.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.y - crop.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.size - crop.size)).toBeLessThanOrEqual(1);
    }
  });
  it("crop smaller than the zoom limit allows: scale clamped at the limit, offset still inside the image", () => {
    const v = cropToView({ x: 10, y: 10, size: 2 }, 4000, 3000, V);
    expect(v.scale).toBe(maxScale(4000, 3000, V));
    expect(v.offset).toEqual(clampOffset(v.offset, v.scale, 4000, 3000, V));
  });
  it("crop outside the image (corrupt data) is also clamped into the image", () => {
    const v = cropToView({ x: 9999, y: 9999, size: 3000 }, 4000, 3000, V);
    expect(v.offset.x).toBeGreaterThanOrEqual(V - 4000 * v.scale);
    expect(v.offset.y).toBeGreaterThanOrEqual(V - 3000 * v.scale);
  });
});

describe("centeredCrop", () => {
  it("centered, takes the short side", () => {
    expect(centeredCrop(4000, 3000)).toEqual({ x: 500, y: 0, size: 3000 });
    expect(centeredCrop(3000, 4000)).toEqual({ x: 0, y: 500, size: 3000 });
    expect(centeredCrop(800, 800)).toEqual({ x: 0, y: 0, size: 800 });
  });
  it("odd difference, very narrow, 1x1 still give integers inside the image", () => {
    for (const [w, h] of [[1001, 1000], [5000, 1], [1, 5000], [1, 1], [3, 2]] as const) {
      const c = centeredCrop(w, h);
      expect(Number.isInteger(c.x) && Number.isInteger(c.y)).toBe(true);
      expect(c.size).toBe(Math.min(w, h));
      expect(c.x + c.size).toBeLessThanOrEqual(w);
      expect(c.y + c.size).toBeLessThanOrEqual(h);
    }
  });
});
