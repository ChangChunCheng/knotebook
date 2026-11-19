import type { AvatarCropDto, AvatarCropUpload } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { resetFillerUser, setFillerUserChangeHandler } from "./filler-user";

// Others can't see an OIDC avatar until the owner's browser generates its display image. State is module-level
// because AppShell remounts on every page change; I/O is injected so this needn't import api/avatars (a cycle).

export interface FillTarget {
  id: string;
  v: number;
}

export interface EncodeModule {
  decodeImage(file: Blob): Promise<ImageBitmap>;
  renderDisplay(bitmap: ImageBitmap, crop: AvatarCropDto): Promise<Blob>;
}

export interface FillerDeps {
  fetchOriginal(id: string, signal?: AbortSignal): Promise<Blob>;
  putDisplay(input: { id: string; display: Blob; crop: AvatarCropUpload; version: number; signal?: AbortSignal }): Promise<unknown>;
  invalidate(): void;
  loadEncode?: () => Promise<EncodeModule>;
  backoffMs?: number;
  timeoutMs?: number;
}

interface QueueItem extends FillTarget {
  retried: boolean;
}

const DEFAULT_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

let deps: FillerDeps | null = null;
let queue: QueueItem[] = [];
let seen = new Set<string>();
let running = false;
let encodePromise: Promise<EncodeModule> | null = null;
/** A new Map on every change: useSyncExternalStore compares by reference. */
let quotaFailed = new Map<string, FillTarget>();
const cropOpen = new Map<string, number>();
const retryTimers = new Map<ReturnType<typeof setTimeout>, FillTarget>();
/** Bumped on every reset; results of fills started earlier are ignored. */
let generation = 0;
const listeners = new Set<() => void>();

const keyOf = (target: FillTarget): string => `${target.id}:${target.v}`;

function emit(): void {
  for (const listener of listeners) listener();
}

export function configureFiller(next: FillerDeps): void {
  deps = next;
}

export function enqueueFill(target: FillTarget): void {
  const key = keyOf(target);
  if (seen.has(key)) return;
  seen.add(key);
  queue.push({ id: target.id, v: target.v, retried: false });
  void pump();
}

export function registerCropOpen(id: string): () => void {
  cropOpen.set(id, (cropOpen.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (cropOpen.get(id) ?? 1) - 1;
    if (left <= 0) cropOpen.delete(id);
    else cropOpen.set(id, left);
    void pump();
  };
}

/** Another path just wrote this candidate: older versions would only hit a version conflict. Newer ones stay. */
export function dropQueuedFill(id: string, v: number): void {
  const stale = (target: FillTarget): boolean => target.id === id && target.v <= v;
  queue = queue.filter(item => !stale(item));
  for (const [timer, target] of retryTimers) {
    if (!stale(target)) continue;
    clearTimeout(timer);
    retryTimers.delete(timer);
  }
  const before = quotaFailed.size;
  quotaFailed = new Map([...quotaFailed].filter(([, target]) => !stale(target)));
  if (quotaFailed.size !== before) emit();
}

/** Any successful avatar write may free space, so quota failures are re-queued. */
export function notifyAvatarWritten(): void {
  if (quotaFailed.size === 0) return;
  const retry = [...quotaFailed.values()];
  quotaFailed = new Map();
  for (const target of retry) {
    seen.delete(keyOf(target));
    enqueueFill(target);
  }
  emit();
}

export function subscribeFiller(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getQuotaFailed(): ReadonlyMap<string, FillTarget> {
  return quotaFailed;
}

export function fillKey(target: FillTarget): string {
  return keyOf(target);
}

export function clearFillerState(): void {
  generation += 1;
  queue = [];
  seen = new Set();
  quotaFailed = new Map();
  for (const timer of retryTimers.keys()) clearTimeout(timer);
  retryTimers.clear();
  emit();
}

export function resetFiller(): void {
  deps = null;
  running = false;
  encodePromise = null;
  cropOpen.clear();
  resetFillerUser();
  clearFillerState();
}

// Loaded lazily, to stay out of the main bundle.
function loadEncode(): Promise<EncodeModule> {
  encodePromise ??= (deps?.loadEncode ?? (() => import("./encode")))().catch((err: unknown) => {
    encodePromise = null;
    throw err;
  });
  return encodePromise;
}

/** false: nothing was sent (the user switched, or the crop dialog opened and the item was re-queued). */
async function fill(item: QueueItem, active: FillerDeps, started: number): Promise<boolean> {
  const timeoutMs = active.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const original = await active.fetchOriginal(item.id, AbortSignal.timeout(timeoutMs));
  const encode = await loadEncode();
  const { centeredCrop } = await import("./crop-math");
  const bitmap = await encode.decodeImage(original);
  let display: Blob;
  let crop: AvatarCropDto;
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    crop = centeredCrop(width, height);
    display = await encode.renderDisplay(bitmap, crop);
  } finally {
    bitmap.close();
  }
  if (started !== generation) return false;
  // Sending now would bump the version, and the user's Save would fail with `avatar_outdated`.
  if (cropOpen.has(item.id)) {
    queue.push(item);
    return false;
  }
  await active.putDisplay({ id: item.id, display, crop: { ...crop, width, height }, version: item.v, signal: AbortSignal.timeout(timeoutMs) });
  return true;
}

function scheduleRetry(item: QueueItem, backoffMs: number): void {
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    queue.push({ id: item.id, v: item.v, retried: true });
    void pump();
  }, backoffMs);
  retryTimers.set(timer, { id: item.id, v: item.v });
}

async function pump(): Promise<void> {
  if (running || deps === null) return;
  running = true;
  try {
    for (;;) {
      const active = deps;
      if (active === null) return;
      const index = queue.findIndex(item => !cropOpen.has(item.id));
      if (index < 0) return;
      const [item] = queue.splice(index, 1) as [QueueItem];
      const started = generation;
      try {
        const sent = await fill(item, active, started);
        if (started !== generation) continue;
        if (sent) {
          active.invalidate();
          notifyAvatarWritten();
        }
      } catch (err) {
        if (started !== generation) continue;
        if (err instanceof ApiFail && err.code === "server_busy" && !item.retried) {
          scheduleRetry(item, active.backoffMs ?? DEFAULT_BACKOFF_MS);
        } else if (err instanceof ApiFail && err.code === "avatar_outdated") {
          // Filled elsewhere or original replaced: refetch and handle the new version. Nothing was written, so quota failures stay.
          active.invalidate();
        } else if (err instanceof ApiFail && err.code === "storage_quota_exceeded") {
          quotaFailed = new Map(quotaFailed).set(keyOf(item), { id: item.id, v: item.v });
          emit();
        }
        // Anything else (network, 5xx, decode, 4xx): this version counts as failed and isn't retried in this tab.
      }
    }
  } finally {
    running = false;
  }
}

// Registered on load; the main-bundle shell's syncFillerUser triggers it on a user switch.
setFillerUserChangeHandler(clearFillerState);
