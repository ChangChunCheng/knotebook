import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "@/i18n/tour-strings";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { X } from "@/components/ui/icons";
import { SAFE_INSETS } from "@/components/ui/safe-area";
import { cn } from "@/lib/utils";
import { arrowPath, cardInsets, cardMaxSize, HOLE_RADIUS, NO_INSETS, padRect, placeCard, sameInsets, type Insets, type Rect, type Size } from "./geometry";

export interface TourOverlayProps {
  /** In viewport coordinates (several targets are merged with `unionRect`); null = no cutout, card centred; the caller re-measures every frame. */
  target: Rect | null;
  step: number;
  /** Step identity (position in the engine's step order): step-change announcements and focus-on-enter use it, not the displayed number (which can change with the layout). */
  stopKey?: number | string;
  hidden?: boolean;
  total: number;
  title: string;
  body: string;
  live?: boolean;
  /** Edge bands the card should avoid (from each window edge); safe areas the card reads itself. Ignored when the screen is too small. */
  keepOut?: Insets;
  blocked?: Insets;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onClose: () => void;
  onKeep: () => void;
  onDelete: () => void;
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const viewportWidth = () => window.innerWidth;
const viewportHeight = () => window.innerHeight;

function readPadding(el: HTMLElement | null): Insets {
  if (el === null) return NO_INSETS;
  const style = getComputedStyle(el);
  const px = (value: string) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}

/** `useId` characters may be invalid inside `url(#…)`; keep alphanumerics only. */
function svgId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/**
 * The card is a dialog with `aria-modal="false"`, not Radix's modal Dialog: modal marks the rest of the page `aria-hidden`/`inert`, so targets couldn't be found and screen readers couldn't read the highlighted thing. Focus and the Tab loop are managed here.
 * `pointerdown` is intercepted in window capture: BlockNote's menus use floating-ui `useDismiss` on document-capture `pointerdown` and close on "outside", ignoring `defaultPrevented`; only something earlier than document can stop it.
 * `preventDefault` keeps focus in place (the demo's editor). So React `onPointerDown` on the card never fires; button actions use `onClick`.
 * Esc is also taken in window capture: with focus in the editor BlockNote closes menus on Esc itself.
 * Cutout, outline, arrow and card have no transitions and jump together: a transition on the cutout alone would detach the arrow tip from the outline, and with the target re-measured every frame (e.g. while scrolling) a transitioned cutout lags it. Without animation `prefers-reduced-motion` needs no handling.
 * The card's name and description are swapped in place on a step change (focus often stays on the same "Next"), which screen readers don't re-read; so a persistent polite live region is filled with "n / N, title, description". Not filled on first mount: focus enters the card and the dialog itself is announced.
 */
export function TourOverlay({
  target,
  step,
  stopKey,
  hidden = false,
  total,
  title,
  body,
  live = false,
  keepOut = NO_INSETS,
  blocked = NO_INSETS,
  onNext,
  onBack,
  onSkip,
  onClose,
  onKeep,
  onDelete,
}: TourOverlayProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const bodyId = `${reactId}-body`;
  const questionId = `${reactId}-question`;
  const maskId = svgId("kb-tour-mask", reactId);
  const markerId = svgId("kb-tour-arrow", reactId);

  const isFirst = step === 1;
  const isLast = step === total;

  const progress = t("tourGuide.progress", { n: step, total });
  // A title already ending in punctuation gets no full stop, or screen readers read "?."; closing quotes/brackets after the punctuation count too.
  const titleStop = /[.!?。．！？…⋯]["'”’」』）)]*$/u.test(title.trimEnd()) ? "" : t("tourGuide.titleStop");
  // Announce only after a step change; content is fixed at that moment, so renumbering or new text from a layout change doesn't announce again.
  // Compare the previous identity during render, saving an extra effect round.
  const key = stopKey ?? step;
  const [prevKey, setPrevKey] = useState(key);
  const [announcement, setAnnouncement] = useState("");
  if (key !== prevKey) {
    setPrevKey(key);
    setAnnouncement(t("tourGuide.stepAnnouncement", { progress, title, titleStop, body }));
  }

  const viewport: Size = {
    width: useSyncExternalStore(subscribeResize, viewportWidth),
    height: useSyncExternalStore(subscribeResize, viewportHeight),
  };

  // The card size is known only after paint: measure once in a layout effect on mount (no flash at a wrong position),
  // then re-measure via ResizeObserver when a step change, language change or narrower window resizes the card.
  const [cardSize, setCardSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      setCardSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [safeArea, setSafeArea] = useState<Insets>(NO_INSETS);
  useLayoutEffect(() => {
    const next = readPadding(safeAreaRef.current);
    setSafeArea((prev) => (sameInsets(prev, next) ? prev : next));
  }, [viewport.width, viewport.height]);
  const insets = cardInsets(safeArea, keepOut, viewport, blocked);
  const maxSize = cardMaxSize(viewport, insets);

  const hole = target === null ? null : padRect(target);
  const placement = placeCard(hole, cardSize, viewport, insets);
  const arrow =
    hole === null ? null : arrowPath(hole, { left: placement.left, top: placement.top, ...cardSize }, placement.placement);

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // Esc during IME composition cancels the composition and belongs to the IME (Chromium's keydown during composition has keyCode 229).
    if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // On the demo step focus is in the editor and the demo decides what Tab does; this only handles the loop inside the card.
    if (e.key !== "Tab" || live) return;
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      at === -1 ? items[e.shiftKey ? items.length - 1 : 0]! : items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length]!;
    next.focus();
  });

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // A regular step focuses the main action on entry (the last step's is [keep sample note], not [delete]); the demo step must leave focus in the editor, or the menu would close.
  // The card is hidden during a screen change; focus again after it appears.
  useEffect(() => {
    if (!live && !hidden) primaryRef.current?.focus();
  }, [key, total, live, hidden]);

  // z-[95]: above editor overlays (BlockNote's highest is 90), below toasts (100).
  return createPortal(
    <div ref={rootRef} data-tour-overlay="" className="fixed inset-0 z-[95]">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full forced-color-adjust-none">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {hole && (
              <rect
                data-tour-hole=""
                x={hole.left}
                y={hole.top}
                width={hole.width}
                height={hole.height}
                rx={HOLE_RADIUS}
                fill="black"
              />
            )}
          </mask>
          <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-brand forced-colors:fill-[Highlight]" />
          </marker>
        </defs>
        <rect width="100%" height="100%" mask={`url(#${maskId})`} className="fill-black/50" />
        {hole && (
          <>
            {/* High-contrast mode: the dark overlay/cutout boundary is invisible, so draw an extra ring in the system text colour */}
            <rect
              data-tour-ring-contrast=""
              x={hole.left - 2}
              y={hole.top - 2}
              width={hole.width + 4}
              height={hole.height + 4}
              rx={HOLE_RADIUS + 2}
              fill="none"
              strokeWidth={2}
              className="hidden forced-colors:inline forced-colors:stroke-[CanvasText]"
            />
            <rect
              data-tour-ring=""
              x={hole.left}
              y={hole.top}
              width={hole.width}
              height={hole.height}
              rx={HOLE_RADIUS}
              fill="none"
              strokeWidth={2}
              className="stroke-brand forced-colors:stroke-[Highlight]"
            />
          </>
        )}
        {arrow && (
          <path
            data-tour-arrow=""
            d={arrow.d}
            fill="none"
            strokeWidth={2}
            markerEnd={`url(#${markerId})`}
            className="stroke-brand forced-colors:stroke-[Highlight]"
          />
        )}
      </svg>
      <div ref={safeAreaRef} aria-hidden="true" className={cn("pointer-events-none invisible fixed inset-0", SAFE_INSETS)} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-card=""
        tabIndex={-1}
        style={{ left: placement.left, top: placement.top, maxWidth: maxSize.width, maxHeight: maxSize.height }}
        className={cn(cardSurface, "fixed w-80 overflow-y-auto p-4 shadow-lg outline-none", hidden && "invisible")}
      >
        <h2 id={titleId} className="pr-8 text-sm font-semibold">
          {title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm text-muted-foreground">
          {body}
        </p>
        {isLast && (
          <p id={questionId} className="mt-2 text-sm">
            {t("tourGuide.keepOrDeleteSample")}
          </p>
        )}
        {/* Mounted empty on regular steps too: only text added to an existing live region is announced */}
        <p aria-live="polite" className={live ? "mt-2 text-xs text-muted-foreground" : undefined}>
          {live ? t("tourGuide.liveHint") : null}
        </p>
        <p data-tour-step-announcement="" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {/* Wraps when one line doesn't fit (320px phone, two long buttons on the last step) so buttons don't overflow the card */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{progress}</span>
          {isFirst && !isLast && (
            <Button type="button" variant="outline" onClick={onSkip}>
              {t("tourGuide.skip")}
            </Button>
          )}
          {!isFirst && (
            <Button type="button" variant="outline" onClick={onBack}>
              {t("tourGuide.back")}
            </Button>
          )}
          {isLast ? (
            <>
              <Button ref={primaryRef} type="button" variant="brandDeep" aria-describedby={questionId} onClick={onKeep}>
                {t("tourGuide.keepSample")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("tourGuide.deleteSampleLabel")}
                aria-describedby={questionId}
                className="border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
              >
                {t("tourGuide.deleteSample")}
              </Button>
            </>
          ) : (
            <Button ref={primaryRef} type="button" variant="brandDeep" onClick={onNext}>
              {t("tourGuide.next")}
            </Button>
          )}
        </div>
        {/* Last in the DOM so Tab order is action buttons → ✕; positioned top right */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-7 w-7"
          aria-label={t("management.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>,
    document.body,
  );
}
