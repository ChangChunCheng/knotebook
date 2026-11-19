type LightboxModule = typeof import("./MediaLightbox");

let pending: Promise<LightboxModule> | null = null;
let loaded: LightboxModule | null = null;

/** Provider and prefetch share one promise, so the chunk downloads and `import()`s once; it is cleared on failure so the next open can retry. */
export function loadMediaLightbox(): Promise<LightboxModule> {
  pending ??= import("./MediaLightbox").then(
    m => {
      loaded = m;
      return m;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

/** Lets the Provider render directly once loaded, skipping even the shortest Suspense wait. */
export function loadedMediaLightbox(): LightboxModule | null {
  return loaded;
}

/** On hover or focus. No-op when loaded or loading; failure is ignored here: opening retries and shows the error. */
export function prefetchMediaLightbox(): void {
  if (loaded !== null || pending !== null) return;
  void loadMediaLightbox().catch(() => undefined);
}
