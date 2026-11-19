import type { QueryClient } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import { fetchAiActions } from "@/api/ai";
import { listStickyTopInset, stickyTopInset } from "@/lib/page-scroll";
import { tourLayout, type TourLayout } from "@/lib/tour-find";
import { readKeyboardInset } from "@/lib/visual-viewport";
import { NO_INSETS, unionRect, type Insets, type Rect } from "./geometry";
import { buildSequence } from "./sequence";
import { FULL_TOUR, prepareStop, STOPS, stopScreen, stopShownIn, stopTarget, type StopContext, type StopDef } from "./stops";


/** Limit for a step's target to appear (with a size) after entering; if it never does the step is skipped. */
export const TARGET_TIMEOUT_MS = 3000;
/** After a phone screen change: a list that doesn't appear still lets the step start (the engine waits for the target); a sample note that doesn't appear (e.g. trashed elsewhere, page shows the "in trash" card) counts as leaving it and ends the tour. */
export const SCREEN_TIMEOUT_MS = 5000;
/** Limit for finding the user-menu trigger after finishing; after navigating back the new sidebar takes a frame or two to mount. */
export const RETURN_FOCUS_TIMEOUT_MS = 1000;

export type { TourStartOptions } from "@/lib/tour-context";

export interface TourStopEntry {
  stop: StopDef;
}

export function fullTourStops(): TourStopEntry[] {
  return buildSequence(FULL_TOUR).map((e) => ({ stop: STOPS[e.id] }));
}

/** Computed once at start: steps whose precondition fails are dropped entirely and the total counts only the rest, so numbers never skip mid-tour. */
export function planStops(entries: readonly TourStopEntry[], ctx: StopContext): TourStopEntry[] {
  return entries.filter((e) => e.stop.precondition?.(ctx) ?? true);
}

/** `staleTime: 0` refetches even cached data: opening from home the cache may be empty or stale. A failed read means no AI; no retry, so the user isn't kept waiting. Shares `["ai-actions"]` with the AI toolbar. */
export function fetchTourAiActions(queryClient: QueryClient): Promise<AiActionDto[]> {
  return queryClient
    .fetchQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions, staleTime: 0, retry: false })
    .catch(() => []);
}

/** Only when every element has a size (highlighting part of them would not match the text). */
export function measureTargets(els: readonly Element[]): Rect | null {
  if (els.length === 0) return null;
  const rects = els.map((el) => el.getBoundingClientRect());
  if (rects.some((r) => r.width <= 0 || r.height <= 0)) return null;
  return unionRect(rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })));
}

/** Counts only steps shown in `layout` (a step absent on phones is skipped at once and takes no number, so numbers never skip). The on-screen step always counts: after a layout change mid-tour the card may still be on a step that layout lacks. */
export function tourProgress(stops: readonly TourStopEntry[], index: number, layout: TourLayout): { step: number; total: number } {
  const counted = stops.map((e, i) => i === index || stopShownIn(e.stop, layout));
  return {
    step: counted.slice(0, index + 1).filter(Boolean).length,
    total: counted.filter(Boolean).length,
  };
}

export interface CardBands {
  keepOut: Insets;
  blocked: Insets;
}

const NO_BANDS: CardBands = { keepOut: NO_INSETS, blocked: NO_INSETS };

function highestTop(selector: string, fallback: number): number {
  let top = fallback;
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest("[inert]") !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) top = Math.min(top, r.top);
  }
  return top;
}

/** iOS pushes the layout up when the keyboard rises (the visual viewport's `offsetTop` grows): the top part is off screen and a card there can't be seen. Pinch zoom also changes `offsetTop`, but that isn't the keyboard. */
function keyboardPanTop(): number {
  const viewport = window.visualViewport;
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, viewport.offsetTop);
}

/** Zero outside phones. The keyboard doesn't shrink `window.innerHeight`, only the visual viewport (`readKeyboardInset`); not subtracting it would put the card behind the keyboard. `blocked` top = the part the keyboard pushes off screen. */
export function measureCardBands(layout: TourLayout): CardBands {
  if (layout !== "phone") return NO_BANDS;
  const height = window.innerHeight;
  const blockedEdge = highestTop("[data-mobile-edit-toolbar]", height - readKeyboardInset());
  const fabEdge = highestTop("[data-phone-fab]", height);
  let top: number;
  if (document.querySelector("[data-phone-list-shown]") !== null) {
    const bar = document.querySelector("[data-phone-top-bar]")?.getBoundingClientRect();
    top = Math.max(listStickyTopInset(), bar !== undefined && bar.height > 0 ? bar.bottom : 0);
  } else {
    top = stickyTopInset();
  }
  return {
    keepOut: { top, right: 0, bottom: Math.max(0, height - fabEdge), left: 0 },
    blocked: { top: keyboardPanTop(), right: 0, bottom: Math.max(0, height - blockedEdge), left: 0 },
  };
}

/** The first `check` runs synchronously at call time; resolves null on timeout or abort. A throwing `check` counts as not ready. */
export function waitForFrames<T>(check: () => T | null, signal: AbortSignal, timeoutMs = Infinity): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | null) => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const tick = () => {
      let value: T | null = null;
      try {
        value = check();
      } catch {
        value = null;
      }
      if (value !== null) finish(value);
      else frame = requestAnimationFrame(tick);
    };
    signal.addEventListener("abort", onAbort);
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(null), timeoutMs);
    tick();
  });
}

/** Modal drawers lock focus and mark the outside `aria-hidden`: the card is unreachable and targets unfindable while it is open. No limit: the start flow's overall timeout is the caller's. */
export async function waitForDrawerClosed(signal: AbortSignal): Promise<void> {
  await waitForFrames(() => (document.querySelector("[data-sidebar-drawer]") === null ? true : null), signal);
}

/** Browser pathname is percent-encoded for non-ASCII slugs; `canonicalNotePath` returns the raw characters. */
export function samePath(pathname: string, path: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed % sequence: compare the raw strings.
  }
  return decoded === path;
}

function interactive(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.closest('[aria-hidden="true"], [inert]') === null;
}

/** Falls back to the note title box, then main (`<main>` isn't focusable: add `tabindex="-1"`). On phones not the title box (focusing a text box raises the keyboard) but the note header's "‹" back to the list. */
export async function focusReturnTarget(returnFocus: () => Element | null, signal: AbortSignal): Promise<HTMLElement | null> {
  const found = await waitForFrames(() => {
    const el = returnFocus();
    return interactive(el) ? el : null;
  }, signal, RETURN_FOCUS_TIMEOUT_MS);
  if (signal.aborted) return null;
  const fallback = tourLayout() === "phone" ? '[data-kb-tour-target="backToList"]' : "input[data-note-title-input]";
  const target =
    found ??
    Array.from(document.querySelectorAll(fallback)).find(interactive) ??
    Array.from(document.querySelectorAll("main")).find(interactive) ??
    null;
  if (target === null) return null;
  if (target.tagName === "MAIN" && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
  return target;
}

function runLeave(entry: TourStopEntry, ctx: StopContext): void {
  try {
    entry.stop.leave?.(ctx);
  } catch (err) {
    console.error(err);
  }
}

function runPrepare(entry: TourStopEntry, ctx: StopContext): void {
  try {
    prepareStop(entry.stop, ctx);
  } catch (err) {
    console.error(err);
  }
}

/** The target is re-queried every frame (after `prepare` switches tab it appears a frame later). If this layout has no such step (e.g. the AI step on phones) returns false at once. */
export async function waitForStopTarget(entry: TourStopEntry, ctx: StopContext, signal: AbortSignal): Promise<boolean> {
  if (!stopShownIn(entry.stop)) return false;
  return (await waitForFrames(() => measureTargets(stopTarget(entry.stop, ctx)), signal, TARGET_TIMEOUT_MS)) !== null;
}

export type EndReason =
  | "keep"
  | "delete"
  /** ✕, Esc, or "Skip" on step 1. */
  | "close"
  /** The location left the sample note (Back, reload, redirected to login, note deleted elsewhere). */
  | "left"
  /** The tour component unmounted. */
  | "unmount";

export interface EngineSnapshot {
  phase: "idle" | "running" | "ended";
  /** Position of the on-screen step in the step order; -1 before step 1. */
  index: number;
  total: number;
  /** The on-screen step; still the previous one while waiting for the next target. */
  entry: TourStopEntry | null;
  /** A step change is in progress (waiting for the next target): next/back do nothing meanwhile. */
  pending: boolean;
  /** The step whose `prepare` already ran and whose target is awaited; null when not changing steps. */
  preparing: TourStopEntry | null;
  endReason: EndReason | null;
}

export type WaitForTarget = (entry: TourStopEntry, ctx: StopContext, signal: AbortSignal) => Promise<boolean>;

/**
 * The step order is fixed at creation (after `planStops`), and so is `ctx`.
 * Enter: `showScreen` → `prepare` → `waitForTarget`; if the target never appears skip in the same direction; going back with none found searches forward from the original step. The last step never skips (it carries [keep sample note]/[delete]): it is entered with a centred card.
 * Leave: the on-screen step's `leave` runs before the next `prepare`, since a menu opened by a demo must close first. Once `prepareStop` is called, `leave` is called once more, also for skipped or half-awaited steps.
 * Outside wide windows `prepareStop` usually skips the step's `prepare` but `leave` still runs, so a step's `leave` must be safe without `prepare`.
 */
export class TourEngine {
  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Incremented on every step change or finish: a result from an interrupted wait doesn't count. */
  private generation = 0;
  private waiting: AbortController | null = null;
  private shown: TourStopEntry | null = null;

  constructor(
    private readonly stops: readonly TourStopEntry[],
    private readonly ctx: StopContext,
    private readonly waitForTarget: WaitForTarget = waitForStopTarget,
  ) {
    this.snapshot = { phase: "idle", index: -1, total: stops.length, entry: null, pending: false, preparing: null, endReason: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private set(patch: Partial<EngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  begin(): Promise<void> {
    if (this.snapshot.phase !== "idle") return Promise.resolve();
    if (this.stops.length === 0) {
      this.end("close");
      return Promise.resolve();
    }
    this.set({ phase: "running" });
    return this.seek(0, 1, 0);
  }

  next(): void {
    const { phase, pending, index, total } = this.snapshot;
    if (phase !== "running" || pending || index < 0 || index >= total - 1) return;
    void this.seek(index + 1, 1, index);
  }

  back(): void {
    const { phase, pending, index } = this.snapshot;
    if (phase !== "running" || pending || index <= 0) return;
    void this.seek(index - 1, -1, index);
  }

  end(reason: EndReason): void {
    if (this.snapshot.phase === "ended") return;
    this.generation += 1;
    this.waiting?.abort();
    this.waiting = null;
    this.leaveShown();
    this.set({ phase: "ended", pending: false, preparing: null, endReason: reason });
  }

  private leaveShown(): void {
    const shown = this.shown;
    this.shown = null;
    if (shown !== null) runLeave(shown, this.ctx);
  }

  /** A failed screen change is only logged to the console and the target is awaited anyway. null when no change is needed (no `showScreen`): the rest of entering runs synchronously. */
  private enterScreen(entry: TourStopEntry, signal: AbortSignal): Promise<void> | null {
    const show = this.ctx.showScreen;
    if (show === undefined || !stopShownIn(entry.stop)) return null;
    return show(stopScreen(entry.stop), signal).catch((err: unknown) => console.error(err));
  }

  private async seek(start: number, direction: 1 | -1, from: number): Promise<void> {
    const generation = ++this.generation;
    const waiting = new AbortController();
    this.waiting = waiting;
    this.leaveShown();
    this.set({ pending: true });
    let i = start;
    let dir = direction;
    for (;;) {
      if (i < 0) {
        i = from;
        dir = 1;
      }
      const entry = this.stops[i]!;
      this.set({ preparing: entry });
      const entering = this.enterScreen(entry, waiting.signal);
      if (entering !== null) {
        await entering;
        if (generation !== this.generation) {
          runLeave(entry, this.ctx);
          return;
        }
      }
      runPrepare(entry, this.ctx);
      const found = await this.waitForTarget(entry, this.ctx, waiting.signal);
      if (generation !== this.generation) {
        runLeave(entry, this.ctx);
        return;
      }
      if (found || i === this.stops.length - 1) {
        this.waiting = null;
        this.shown = entry;
        this.set({ index: i, entry, pending: false, preparing: null });
        return;
      }
      runLeave(entry, this.ctx);
      i += dir;
    }
  }
}
