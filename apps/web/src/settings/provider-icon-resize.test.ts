import { describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_ICON_SOURCE_BYTES } from "@knotebook/shared";
import { ProviderIconResizeError, providerIconTargetSize, resizeProviderIcon, type ResizeDeps } from "./provider-icon-resize";

/** jsdom has no canvas / createImageBitmap: inject stand-ins to check the size computation and MIME. The real browser path is covered by e2e. */
function fakeDeps(size: { width: number; height: number }, opts: { decodeFails?: boolean; noContext?: boolean; nullBlob?: boolean } = {}) {
  const close = vi.fn();
  const bitmap = { ...size, close } as unknown as ImageBitmap;
  const ctx = { drawImage: vi.fn(), imageSmoothingQuality: "low" as ImageSmoothingQuality };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (opts.noContext ? null : ctx)),
    toBlob: vi.fn((cb: BlobCallback, type?: string) => cb(opts.nullBlob ? null : new Blob([new Uint8Array([0x89, 0x50])], { type }))),
  };
  const deps: ResizeDeps = {
    decode: vi.fn(async () => {
      if (opts.decodeFails) throw new Error("bad image");
      return bitmap;
    }),
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
  };
  return { deps, canvas, ctx, bitmap, close };
}
const png = (bytes = 10, type = "image/png") => new File([new Uint8Array(bytes)], "a.png", { type });
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof ProviderIconResizeError ? err.reason : `other: ${String(err)}`;
  }
};

describe("providerIconTargetSize", () => {
  it("512x256 -> 128x64; 64x300 -> 27x128; 100x50 -> 100x50 (not enlarged); 128x128 unchanged; extreme aspect ratios get at least 1 px", () => {
    expect(providerIconTargetSize(512, 256)).toEqual({ width: 128, height: 64 });
    expect(providerIconTargetSize(64, 300)).toEqual({ width: 27, height: 128 });
    expect(providerIconTargetSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(providerIconTargetSize(128, 128)).toEqual({ width: 128, height: 128 });
    expect(providerIconTargetSize(5000, 1)).toEqual({ width: 128, height: 1 });
    expect(providerIconTargetSize(300, 100)).toEqual({ width: 128, height: 43 });
  });
});

describe("resizeProviderIcon", () => {
  it("512x256 -> canvas 128x64, drawImage(bitmap, 0, 0, 128, 64), high-quality smoothing, outputs image/png; the bitmap is released", async () => {
    const f = fakeDeps({ width: 512, height: 256 });
    const blob = await resizeProviderIcon(png(), f.deps);
    expect(f.canvas.width).toBe(128);
    expect(f.canvas.height).toBe(64);
    expect(f.ctx.drawImage).toHaveBeenCalledWith(f.bitmap, 0, 0, 128, 64);
    expect(f.ctx.imageSmoothingQuality).toBe("high");
    expect(f.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(blob.type).toBe("image/png");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("64x300 -> 27x128; 100x50 -> 100x50 (not enlarged, only re-encoded)", async () => {
    const tall = fakeDeps({ width: 64, height: 300 });
    await resizeProviderIcon(png(), tall.deps);
    expect([tall.canvas.width, tall.canvas.height]).toEqual([27, 128]);
    const small = fakeDeps({ width: 100, height: 50 });
    await resizeProviderIcon(png(), small.deps);
    expect([small.canvas.width, small.canvas.height]).toEqual([100, 50]);
    expect(small.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
  });

  it("JPEG and WebP are also accepted (output is always PNG)", async () => {
    for (const type of ["image/jpeg", "image/webp"]) {
      const f = fakeDeps({ width: 10, height: 10 });
      expect((await resizeProviderIcon(png(10, type), f.deps)).type, type).toBe("image/png");
    }
  });

  it("GIF / SVG / empty type -> unsupportedType, no decode", async () => {
    for (const type of ["image/gif", "image/svg+xml", ""]) {
      const f = fakeDeps({ width: 10, height: 10 });
      expect(await reasonOf(resizeProviderIcon(png(10, type), f.deps)), type).toBe("unsupportedType");
      expect(f.deps.decode, type).not.toHaveBeenCalled();
    }
  });

  it("> 5 MB -> tooLarge, no decode; exactly 5 MB passes", async () => {
    const big = fakeDeps({ width: 10, height: 10 });
    expect(await reasonOf(resizeProviderIcon(png(MAX_PROVIDER_ICON_SOURCE_BYTES + 1), big.deps))).toBe("tooLarge");
    expect(big.deps.decode).not.toHaveBeenCalled();
    const edge = fakeDeps({ width: 10, height: 10 });
    expect(await reasonOf(resizeProviderIcon(png(MAX_PROVIDER_ICON_SOURCE_BYTES), edge.deps))).toBe("resolved");
  });

  it("decode failure / getContext returns null / toBlob returns null -> unreadable; a failure after decoding also releases the bitmap", async () => {
    expect(await reasonOf(resizeProviderIcon(png(), fakeDeps({ width: 10, height: 10 }, { decodeFails: true }).deps))).toBe("unreadable");
    const noCtx = fakeDeps({ width: 10, height: 10 }, { noContext: true });
    expect(await reasonOf(resizeProviderIcon(png(), noCtx.deps))).toBe("unreadable");
    expect(noCtx.close).toHaveBeenCalledTimes(1);
    const nullBlob = fakeDeps({ width: 10, height: 10 }, { nullBlob: true });
    expect(await reasonOf(resizeProviderIcon(png(), nullBlob.deps))).toBe("unreadable");
    expect(nullBlob.close).toHaveBeenCalledTimes(1);
  });
});
