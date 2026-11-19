import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatBytes, type AvatarCandidateDto, type AvatarCropUpload } from "@knotebook/shared";
import { AVATARS_QUERY_KEY, fetchAvatarOriginal, useUpdateAvatarDisplay, useUploadAvatar } from "@/api/avatars";
import { useAuthConfig } from "@/api/authConfig";
import { ApiFail } from "@/api/client";
import { dropQueuedFill, registerCropOpen } from "@/avatars/display-filler";
import { centeredCrop, clampOffset, cropToView, maxScale, minScale, viewToCrop, zoomAround, type Point } from "@/avatars/crop-math";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { storageQuotaDescription } from "@/lib/storage-quota-text";
import "@/i18n/management-strings";

export type AvatarCropSource = { kind: "new"; file: File } | { kind: "existing"; candidate: AvatarCandidateDto };

export interface AvatarCropDialogProps {
  open: boolean;
  source: AvatarCropSource;
  onOpenChange: (open: boolean) => void;
  /** Called after the server accepts it; the dialog then closes itself. */
  onSaved: (candidate: AvatarCandidateDto) => void;
}

interface ErrorText {
  title: string;
  detail?: string;
}

/** Frame side length used before layout, while the real width can't be measured. */
const DEFAULT_VIEWPORT = 280;
const KEY_STEP = 10;
const KEY_STEP_SHIFT = 50;
/** Zoom factor per `+`/`-` step. */
const ZOOM_STEP = 1.2;
/** Zoom exponent per wheel deltaY unit. */
const WHEEL_SENSITIVITY = 0.002;

/** Coordinate conventions: see `avatars/crop-math.ts`. */
interface Geometry {
  width: number;
  height: number;
  viewport: number;
  scale: number;
  offset: Point;
}

function zoomGeometry(g: Geometry, nextScale: number, anchor: Point): Geometry {
  const next = zoomAround({ scale: g.scale, offset: g.offset }, nextScale, anchor, g.width, g.height, g.viewport);
  return { ...g, scale: next.scale, offset: next.offset };
}

function moveGeometry(g: Geometry, dx: number, dy: number): Geometry {
  return { ...g, offset: clampOffset({ x: g.offset.x + dx, y: g.offset.y + dy }, g.scale, g.width, g.height, g.viewport) };
}

const ARROW_DELTAS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Arrow keys move the image that way by 10 px (Shift: 50 px); `+`/`-` zoom one step. Decoding and encoding (`avatars/encode.ts`) load via
 * dynamic `import()` only on Save, outside this dialog's chunk. Not closable while uploading (including encoding): Esc, X and Cancel are
 * ignored. The `blob:` URL is released on close.
 */
export function AvatarCropDialog({ open, source, onOpenChange, onSaved }: AvatarCropDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const upload = useUploadAvatar();
  const update = useUpdateAvatarDisplay();
  const maxUploadBytes = useAuthConfig().data?.maxUploadBytes;
  const file = source.kind === "new" ? source.file : null;
  const candidateId = source.kind === "existing" ? source.candidate.id : null;
  const initialCrop = source.kind === "existing" ? source.candidate.crop : null;
  const existingVersion = source.kind === "existing" ? source.candidate.avatar.v : null;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const [original, setOriginal] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  /** Candidate version at fetch time; re-crop always submits it, regardless of later prop changes. */
  const [originalVersion, setOriginalVersion] = useState<number | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const pinchDistance = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // While open, background regeneration skips this image: otherwise it would bump the version and Save would hit `avatar_outdated`, losing the crop.
  useEffect(() => {
    if (!open || candidateId === null) return;
    return registerCropOpen(candidateId);
  }, [open, candidateId]);

  function describeError(err: unknown): ErrorText {
    const generic = { title: t("settings.account.avatar.crop.uploadFailed") };
    const unreadable = { title: t("settings.account.avatar.crop.unreadable") };
    if (err instanceof ApiFail) {
      switch (err.code) {
        case "storage_quota_exceeded":
          return { title: t("errors.storage_quota_exceeded"), detail: storageQuotaDescription(err, t) };
        case "server_busy":
        case "too_many_requests":
          return { title: t(`errors.${err.code}`) };
      }
      if (err.status === 413) return maxUploadBytes === undefined ? generic : { title: t("settings.account.avatar.tooLarge", { size: formatBytes(maxUploadBytes) }) };
      if (err.status === 415) return unreadable;
      return generic;
    }
    return generic;
  }

  /** Loading an existing candidate's original: nothing was uploaded, so never say "upload failed". */
  function describeLoadError(err: unknown): ErrorText {
    if (err instanceof ApiFail && err.status === 404) return { title: t("errors.not_found") };
    return { title: t("settings.account.avatar.crop.unreadable") };
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const activePointers = pointers.current;
    let objectUrl: string | null = null;
    const begin = (blob: Blob, version: number | null) => {
      objectUrl = URL.createObjectURL(blob);
      setOriginal(blob);
      setOriginalVersion(version);
      setUrl(objectUrl);
    };
    if (file !== null) {
      begin(file, null);
    } else if (candidateId !== null) {
      const versionAtFetch = existingVersion;
      fetchAvatarOriginal(candidateId).then(
        blob => {
          if (!cancelled) begin(blob, versionAtFetch);
        },
        (err: unknown) => {
          if (!cancelled) setError(describeLoadError(err));
        },
      );
    }
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      setOriginal(null);
      setOriginalVersion(null);
      setUrl(null);
      setGeo(null);
      setError(null);
      activePointers.clear();
      pinchDistance.current = null;
    };
    // describeLoadError reads the locale only on failure and existingVersion is read once when the fetch starts; only source and open are real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file, candidateId]);

  // Native listener: React's onWheel is passive and can't preventDefault (needed to keep the page behind from scrolling).
  useEffect(() => {
    if (viewportNode === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (busyRef.current) return;
      const rect = viewportNode.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * WHEEL_SENSITIVITY);
      setGeo(g => (g === null ? g : zoomGeometry(g, g.scale * factor, anchor)));
    };
    viewportNode.addEventListener("wheel", onWheel, { passive: false });
    return () => viewportNode.removeEventListener("wheel", onWheel);
  }, [viewportNode]);

  // The frame's side length changes with the viewport (phone rotation, CSS breakpoints): rescale zoom and offset by the old/new ratio so the
  // circle shows the same content; at the max zoom, scale about the frame center; saving converts the crop using the current side length.
  useEffect(() => {
    if (viewportNode === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = viewportNode.clientWidth;
      if (!(next > 0)) return;
      setGeo(g => {
        if (g === null || g.viewport === next) return g;
        const ratio = next / g.viewport;
        const scaled = { scale: g.scale * ratio, offset: { x: g.offset.x * ratio, y: g.offset.y * ratio } };
        const view = zoomAround(scaled, scaled.scale, { x: next / 2, y: next / 2 }, g.width, g.height, next);
        return { ...g, viewport: next, ...view };
      });
    });
    observer.observe(viewportNode);
    return () => observer.disconnect();
  }, [viewportNode]);

  function handleImageLoad(event: { currentTarget: HTMLImageElement }): void {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (!(width > 0 && height > 0)) {
      setError({ title: t("settings.account.avatar.crop.unreadable") });
      return;
    }
    const measured = viewportRef.current?.clientWidth ?? 0;
    const viewport = measured > 0 ? measured : DEFAULT_VIEWPORT;
    const view = cropToView(initialCrop ?? centeredCrop(width, height), width, height, viewport);
    setError(null);
    setGeo({ width, height, viewport, scale: view.scale, offset: view.offset });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Leave modified combos (Ctrl/Cmd + `=`/`-` page zoom) to the browser.
    if (busy || event.ctrlKey || event.metaKey || event.altKey) return;
    const arrow = ARROW_DELTAS[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
      setGeo(g => (g === null ? g : moveGeometry(g, arrow.x * step, arrow.y * step)));
      return;
    }
    const direction = event.key === "+" || event.key === "=" ? 1 : event.key === "-" ? -1 : 0;
    if (direction !== 0) {
      event.preventDefault();
      setGeo(g => (g === null ? g : zoomGeometry(g, direction > 0 ? g.scale * ZOOM_STEP : g.scale / ZOOM_STEP, { x: g.viewport / 2, y: g.viewport / 2 })));
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (geo === null || busy) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail (e.g. the pointer already ended); dragging is unaffected.
    }
    const points = [...pointers.current.values()];
    pinchDistance.current = points.length === 2 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : null;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (busy) return;
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, current);
    if (pointers.current.size === 1) {
      setGeo(g => (g === null ? g : moveGeometry(g, current.x - previous.x, current.y - previous.y)));
      return;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const last = pinchDistance.current;
      pinchDistance.current = distance;
      if (last === null || last <= 0 || distance <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const anchor = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      setGeo(g => (g === null ? g : zoomGeometry(g, (g.scale * distance) / last, anchor)));
    }
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    pointers.current.delete(event.pointerId);
    pinchDistance.current = null;
  }

  async function handleSave(): Promise<void> {
    if (geo === null || original === null || busy) return;
    if (source.kind === "existing" && originalVersion === null) return;
    setError(null);
    setBusy(true);
    try {
      // Dynamic import: separate chunk, kept out of the initial bundle.
      const encode = await import("@/avatars/encode");
      let display: Blob;
      let crop: AvatarCropUpload;
      try {
        const bitmap = await encode.decodeImage(original);
        try {
          const box = viewToCrop({ scale: geo.scale, offset: geo.offset }, bitmap.width, bitmap.height, geo.viewport);
          crop = { ...box, width: bitmap.width, height: bitmap.height };
          display = await encode.renderDisplay(bitmap, box);
        } finally {
          bitmap.close();
        }
      } catch {
        // Unreadable, undrawable or oversized: the image itself is bad, so don't submit.
        if (mounted.current) {
          setBusy(false);
          setError({ title: t("settings.account.avatar.crop.unreadable") });
        }
        return;
      }
      const saved =
        source.kind === "existing" && originalVersion !== null
          ? await update.mutateAsync({ id: source.candidate.id, display, crop, version: originalVersion })
          : await upload.mutateAsync({ original, display, crop });
      // This save is the regeneration: drop the queued older-version one (it would only conflict).
      if (source.kind === "existing") dropQueuedFill(source.candidate.id, saved.avatar.v);
      if (!mounted.current) return;
      setBusy(false);
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      if (!mounted.current) return;
      setBusy(false);
      if (err instanceof ApiFail && err.code === "avatar_outdated") {
        void queryClient.invalidateQueries({ queryKey: AVATARS_QUERY_KEY });
        toast({ title: t("errors.avatar_outdated"), variant: "destructive" });
        onOpenChange(false);
        return;
      }
      setError(describeError(err));
    }
  }

  const lo = geo === null ? 0 : minScale(geo.width, geo.height, geo.viewport);
  const hi = geo === null ? 1 : maxScale(geo.width, geo.height, geo.viewport);

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        dismissOnOutside={false}
        onOpenAutoFocus={event => {
          event.preventDefault();
          viewportRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("settings.account.avatar.crop.title")}</DialogTitle>
          <DialogDescription>{t("settings.account.avatar.crop.description")}</DialogDescription>
        </DialogHeader>
        <div
          ref={node => {
            viewportRef.current = node;
            setViewportNode(node);
          }}
          role="application"
          aria-roledescription={t("settings.account.avatar.crop.area")}
          aria-label={t("settings.account.avatar.crop.title")}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          className="relative mx-auto aspect-square w-[min(280px,calc(100vw-48px))] touch-none select-none overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {url !== null && (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={handleImageLoad}
              onError={() => setError({ title: t("settings.account.avatar.crop.unreadable") })}
              className="pointer-events-none absolute max-w-none"
              style={
                geo === null
                  ? { opacity: 0 }
                  : { left: geo.offset.x, top: geo.offset.y, width: geo.width * geo.scale, height: geo.height * geo.scale }
              }
            />
          )}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] ring-1 ring-white/70" />
        </div>
        <input
          type="range"
          aria-label={t("settings.account.avatar.crop.zoom")}
          min={lo}
          max={hi}
          step="any"
          value={geo?.scale ?? lo}
          disabled={geo === null || busy}
          onChange={event => {
            const next = Number(event.target.value);
            setGeo(g => (g === null || !(next > 0) ? g : zoomGeometry(g, next, { x: g.viewport / 2, y: g.viewport / 2 })));
          }}
          className="mx-auto w-[min(280px,calc(100vw-48px))]"
        />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            <span>{error.title}</span>
            {error.detail !== undefined && <span className="block">{error.detail}</span>}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="brandDeep" disabled={busy || geo === null || original === null} onClick={() => void handleSave()}>
            {busy ? t("settings.account.avatar.crop.saving") : t("settings.account.avatar.crop.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
