import { describe, expect, it, vi } from "vitest";
import { AVATAR_DISPLAY_SIZE, MAX_AVATAR_DISPLAY_BYTES } from "@knotebook/shared";
import { AvatarImageError, decodeImage, renderDisplay, type EncodeDeps } from "./encode";

/** jsdom has no canvas / createImageBitmap: stand-ins are injected to check call shapes; real encoding is covered by e2e. */
function fakeDeps(results: Array<{ type: string; size?: number } | null>, opts: { noContext?: boolean } = {}) {
  const calls: string[] = [];
  const ctx = {
    imageSmoothingQuality: "low" as ImageSmoothingQuality,
    fillStyle: "",
    drawImage: vi.fn(() => calls.push("draw")),
    fillRect: vi.fn(() => calls.push("fill")),
  };
  let n = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (opts.noContext ? null : ctx)),
    toBlob: vi.fn((cb: BlobCallback) => {
      calls.push("toBlob");
      const r = results[n++] ?? null;
      cb(r === null ? null : new Blob([new Uint8Array(r.size ?? 10)], { type: r.type }));
    }),
  };
  const deps: EncodeDeps = { createCanvas: () => canvas as unknown as HTMLCanvasElement };
  return { deps, canvas, ctx, calls };
}
const bitmap = { width: 600, height: 400 } as unknown as ImageBitmap;
const crop = { x: 100, y: 0, size: 400 };

describe("renderDisplay", () => {
  it("canvas 256x256, drawImage source rect = crop, destination = whole canvas; webp used directly", async () => {
    const f = fakeDeps([{ type: "image/webp" }]);
    const blob = await renderDisplay(bitmap, crop, f.deps);
    expect(f.canvas.width).toBe(AVATAR_DISPLAY_SIZE);
    expect(f.canvas.height).toBe(AVATAR_DISPLAY_SIZE);
    expect(f.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(f.ctx.drawImage).toHaveBeenCalledWith(bitmap, 100, 0, 400, 400, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    expect(f.ctx.imageSmoothingQuality).toBe("high");
    expect(f.canvas.toBlob).toHaveBeenCalledTimes(1);
    expect(f.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.9);
    expect(f.ctx.fillRect).not.toHaveBeenCalled();
    expect(blob.type).toBe("image/webp");
  });

  it("browser lacks WebP (toBlob returns png) -> fill white and redraw, produce image/jpeg quality 0.9", async () => {
    const f = fakeDeps([{ type: "image/png" }, { type: "image/jpeg" }]);
    const blob = await renderDisplay(bitmap, crop, f.deps);
    expect(f.canvas.toBlob).toHaveBeenCalledTimes(2);
    expect(f.canvas.toBlob).toHaveBeenLastCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(f.ctx.fillStyle).toBe("#ffffff");
    expect(f.ctx.fillRect).toHaveBeenCalledWith(0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    expect(f.calls).toEqual(["draw", "toBlob", "fill", "draw", "toBlob"]);
    expect(f.ctx.drawImage).toHaveBeenLastCalledWith(bitmap, 100, 0, 400, 400, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    expect(blob.type).toBe("image/jpeg");
  });

  it("toBlob returns null (encode failure) also falls back to jpeg", async () => {
    const f = fakeDeps([null, { type: "image/jpeg" }]);
    expect((await renderDisplay(bitmap, crop, f.deps)).type).toBe("image/jpeg");
  });

  it("jpeg also fails -> AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/png" }, null]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("jpeg fallback produces something that isn't jpeg -> AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/png" }, { type: "image/png" }]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("output over the display image limit -> AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/webp", size: MAX_AVATAR_DISPLAY_BYTES + 1 }]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("exactly at the limit is accepted", async () => {
    const f = fakeDeps([{ type: "image/webp", size: MAX_AVATAR_DISPLAY_BYTES }]);
    expect((await renderDisplay(bitmap, crop, f.deps)).size).toBe(MAX_AVATAR_DISPLAY_BYTES);
  });

  it("no 2d context -> AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/webp" }], { noContext: true });
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });
});

describe("decodeImage", () => {
  it("passes imageOrientation: from-image and returns the bitmap", async () => {
    const spy = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", spy);
    try {
      const file = new Blob([new Uint8Array(3)], { type: "image/png" });
      await expect(decodeImage(file)).resolves.toBe(bitmap);
      expect(spy).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("decode failure -> AvatarImageError", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("bad"); }));
    try {
      await expect(decodeImage(new Blob([new Uint8Array(3)]))).rejects.toBeInstanceOf(AvatarImageError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AvatarImageError", () => {
  it("name is a literal string (the first-chunk check uses it as a marker, so minify mustn't change it)", () => {
    expect(new AvatarImageError("x").name).toBe("AvatarImageError");
  });
});
