import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { VERSIONS_PANEL_PLACEMENT } from "./versions-panel-width";

/**
 * Wrap every `VersionsLazy` mount point: the version UI is a nested lazy under NotePage that throws at render time; unwrapped, a chunk load failure would fall to NotePage's route boundary and use up the notepage auto-reload allowance, reloading the whole page.
 * This uses its own allowance alias `versions` and `frame="inline"` (error plus retry in place). Non-chunk render errors show `versions.crash` (not `app.noteCrash`, which suggests the whole note is broken).
 * `errorClassName` gives the frame for each mount point and applies only in the error state.
 * `ChunkLoadBeacon` must be inside `<Suspense>`: outside it the flag is cleared while lazy is still pending → infinite reload (see its comment in `ErrorBoundary.tsx`).
 */
export function VersionsLazyBoundary({
  noteId,
  fallback = null,
  reload,
  errorClassName,
  crashMessageKey = "versions.crash",
  children,
}: {
  noteId: string | null;
  fallback?: ReactNode;
  reload?: () => void;
  errorClassName?: string;
  /** i18n key for non-chunk render error text (default `versions.crash`); the selection-AI preview passes `ai.box.previewCrash`. Retry semantics unchanged (chunk failure = full reload). */
  crashMessageKey?: string;
  children: ReactNode;
}) {
  return (
    <LazyRouteErrorBoundary
      resetKey={noteId ?? undefined}
      chunk="versions"
      frame="inline"
      reload={reload}
      crashMessageKey={crashMessageKey}
      inlineErrorClassName={errorClassName}
    >
      <Suspense fallback={fallback}>
        <ChunkLoadBeacon chunk="versions" />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}

/** Error frame per mount point. Panel: a card at the panel's position and width (from `--versions-panel-width` set by NoteEditor's row container, the same source as the panel); dialogs and full page: a small card floating bottom right (not at the end of the layout). */
export const VERSIONS_ERROR_FRAME = {
  panel: cn(cardSurface, "shrink-0 p-3", VERSIONS_PANEL_PLACEMENT),
  inline: "px-5 py-2",
  floating: cn(cardSurface, "fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] z-50 p-3 shadow-lg",
    "sm:left-auto sm:right-[calc(1.5rem+env(safe-area-inset-right))] sm:w-80"),
};
