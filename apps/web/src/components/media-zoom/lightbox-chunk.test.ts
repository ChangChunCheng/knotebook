import { describe, expect, it } from "vitest";
import { loadedMediaLightbox, loadMediaLightbox, prefetchMediaLightbox } from "./lightbox-chunk";

describe("lightbox-chunk", () => {
  it("returns the same promise; after loading loadedMediaLightbox returns the module; prefetching does not trigger twice", async () => {
    expect(loadedMediaLightbox()).toBeNull();
    prefetchMediaLightbox();
    const first = loadMediaLightbox();
    expect(loadMediaLightbox()).toBe(first);
    const mod = await first;
    expect(loadedMediaLightbox()).toBe(mod);
    prefetchMediaLightbox();
    expect(loadMediaLightbox()).toBe(first);
  });
});
