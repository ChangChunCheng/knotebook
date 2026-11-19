import { lazy, useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { MediaZoomContext, type MediaZoomApi, type ZoomOrigin, type ZoomSource } from "./context";
import { focusReturnTarget } from "./focus-return";
import { LightboxFallback } from "./LightboxFallback";
import { loadedMediaLightbox, loadMediaLightbox } from "./lightbox-chunk";

// The lightbox downloads on first open only (`scripts/check-bundle-size.mjs` guards it as its own chunk); load it only via
// `lightbox-chunk.ts` (also prefetched on hover) and never import it statically elsewhere.
const LazyMediaLightbox = lazy(() => loadMediaLightbox().then(m => ({ default: m.MediaLightbox })));

interface OpenState {
  source: ZoomSource;
  origin: ZoomOrigin;
  /** Chunk already loaded at open: render directly, bypassing `lazy()`/Suspense (whose first render always shows the fallback briefly). */
  ready: boolean;
}

export function MediaZoomProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<OpenState | null>(null);

  const open = useCallback((source: ZoomSource, origin: ZoomOrigin) => {
    setState({ source, origin, ready: loadedMediaLightbox() !== null });
  }, []);
  const close = useCallback(() => setState(null), []);

  const api = useMemo<MediaZoomApi>(() => ({ open, isOpen: state !== null }), [open, state]);

  const Lightbox = state?.ready ? (loadedMediaLightbox()?.MediaLightbox ?? LazyMediaLightbox) : LazyMediaLightbox;

  return (
    <MediaZoomContext.Provider value={api}>
      {children}
      {state !== null && (
        <SidebarLazyBoundary
          chunk="mediaZoom"
          fallback={
            <LightboxFallback
              source={state.source}
              onClose={() => {
                close();
                focusReturnTarget(state.origin.button, state.origin.media)?.focus();
              }}
            />
          }
          errorClassName="p-2"
        >
          <Lightbox
            source={state.source}
            onClose={close}
            restoreFocus={() => focusReturnTarget(state.origin.button, state.origin.media)?.focus()}
          />
        </SidebarLazyBoundary>
      )}
    </MediaZoomContext.Provider>
  );
}
