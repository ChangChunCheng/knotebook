import { lazy, useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { MediaZoomContext, type MediaZoomApi, type ZoomOrigin, type ZoomSource } from "./context";
import { focusReturnTarget } from "./focus-return";

// 放大畫面只在第一次打開時才下載（`scripts/check-bundle-size.mjs` 守著它是自己的 chunk）。
// 這裡是唯一載入它的地方，別處不得靜態 import。
const MediaLightbox = lazy(() => import("./MediaLightbox").then(m => ({ default: m.MediaLightbox })));

interface OpenState {
  source: ZoomSource;
  origin: ZoomOrigin;
}

/** 持有放大畫面的開關狀態；子樹裡的放大鈕經 `useMediaZoom()` 打開它。 */
export function MediaZoomProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<OpenState | null>(null);

  const open = useCallback((source: ZoomSource, origin: ZoomOrigin) => {
    setState({ source, origin });
  }, []);
  const close = useCallback(() => setState(null), []);

  const api = useMemo<MediaZoomApi>(() => ({ open, isOpen: state !== null }), [open, state]);

  return (
    <MediaZoomContext.Provider value={api}>
      {children}
      {state !== null && (
        <SidebarLazyBoundary chunk="mediaZoom" fallback={null} errorClassName="p-2">
          <MediaLightbox
            source={state.source}
            onClose={close}
            restoreFocus={() => focusReturnTarget(state.origin.button, state.origin.media)?.focus()}
          />
        </SidebarLazyBoundary>
      )}
    </MediaZoomContext.Provider>
  );
}
