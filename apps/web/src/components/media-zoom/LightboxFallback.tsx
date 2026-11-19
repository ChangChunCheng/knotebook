import { useEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "@/components/ui/icons";
import type { ZoomSource } from "./context";
import { fitScale, type Size } from "./zoom-math";

function positive(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

/**
 * Placeholder until content is ready: with a natural size it reserves space with the lightbox's fit-to-viewport math (no jump on swap),
 * otherwise a neutral square. `viewport` defaults to the browser window.
 */
export function ZoomSkeleton({ natural, viewport }: { natural?: Size; viewport?: Size }): JSX.Element {
  // clientWidth excludes the scrollbar, like the `fixed inset-0` lightbox.
  const view = viewport ?? { width: document.documentElement.clientWidth, height: window.innerHeight };
  const known = natural !== undefined && positive(natural) && positive(view);
  const scale = known ? fitScale(natural, view) : 1;
  return (
    <div
      aria-hidden="true"
      data-zoom-skeleton=""
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-card/60 motion-safe:animate-pulse"
      style={
        known
          ? { aspectRatio: `${natural.width} / ${natural.height}`, width: `${natural.width * scale}px`, height: `${natural.height * scale}px` }
          : { width: "min(90vw, 32rem)", height: "min(60vh, 24rem)" }
      }
    />
  );
}

/**
 * Stands in while the lightbox chunk downloads; lives in the entry bundle, so keep it small. Backdrop, placeholder and close button mount
 * under `document.body` like Radix; Esc, the close button and backdrop clicks close it, and Tab stays on the close button.
 */
export function LightboxFallback({ source, onClose }: { source: ZoomSource; onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const title =
    source.kind === "image" ? source.caption || source.alt || t("note.zoom.imageTitle") : t("note.zoom.diagramTitle");
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-zoom-fallback=""
      className="fixed inset-0 z-50 bg-black/80 outline-none"
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Tab") {
          event.preventDefault();
          closeRef.current?.focus();
          return;
        }
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <ZoomSkeleton natural={{ width: source.naturalWidth, height: source.naturalHeight }} />
      <button
        ref={closeRef}
        type="button"
        aria-label={t("note.zoom.close")}
        onClick={onClose}
        className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] rounded-full bg-black/50 p-2 text-white/90 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body,
  );
}
