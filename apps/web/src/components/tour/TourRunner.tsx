import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { NavigationType, useLocation, useNavigate, useNavigationType } from "react-router";
import { useRealNavigationType } from "@/lib/real-location";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";
import { useSidebarQuery } from "@/lib/sidebar-query";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { getShellControls, getTourNoteEditor } from "@/lib/tour-bridge";
import { tourLayout, useTourLayout } from "@/lib/tour-find";
import { showTrashedToast, type Translate } from "@/lib/trash-undo";
import {
  fetchTourAiActions,
  focusReturnTarget,
  fullTourStops,
  measureCardBands,
  measureTargets,
  planStops,
  RETURN_FOCUS_TIMEOUT_MS,
  samePath,
  SCREEN_TIMEOUT_MS,
  TourEngine,
  tourProgress,
  type CardBands,
  waitForDrawerClosed,
  waitForFrames,
  type EndReason,
  type EngineSnapshot,
  type TourStartOptions,
  type TourStopEntry,
} from "./engine";
import { NO_INSETS, sameInsets, type Rect } from "./geometry";
import { canRunLiveStop, installLiveStopInput } from "./live-stops";
import { stopTitle } from "./sequence";
import { stopBody, stopScreen, stopTarget, type StopContext, type TourScreen } from "./stops";
import { TourOverlay } from "./TourOverlay";

export interface TourRunnerProps extends TourStartOptions {
  /** null = the tour can't start (it shows its own toast); `signal` aborts on unmount. `aiActions` is the single read of AI actions per round (never rejects; failure = []): sample content and steps use the same copy, so both agree. Must resolve only after the sample note's page is mounted: the first location check would otherwise end the tour as `left`. */
  prepareSample: (signal: AbortSignal, aiActions: Promise<AiActionDto[]>) => Promise<NoteDto | null>;
  /** Called exactly once per round when step 1 appears (not repeated by re-render, going back or StrictMode); not called if aborted before the start. */
  onStarted?: () => void;
  /** Called once after the tour ended and the restore finished; also when it couldn't start; not called on unmount. */
  onFinished: (result: TourResult) => void;
  stops?: readonly TourStopEntry[];
}

/** completed: last step ([keep sample note] or [delete]). closed: ✕, Esc or "Skip" on step 1. left: the location left the sample note after entering the steps. aborted: stopped before step 1 appeared (couldn't prepare the sample note, or left the page while AI actions were read). */
export type TourFinishReason = "completed" | "closed" | "left" | "aborted";

export interface TourResult {
  started: boolean;
  reason: TourFinishReason;
}

function finishReason(reason: EndReason, started: boolean): TourFinishReason {
  if (!started) return "aborted";
  if (reason === "keep" || reason === "delete") return "completed";
  return reason === "left" ? "left" : "closed";
}

interface Run {
  engine: TourEngine;
  stops: readonly TourStopEntry[];
  note: NoteDto;
  path: string;
  tab: SidebarTab | null;
  ctx: StopContext;
}

const LIST_PATH = "/";

function screenReady(screen: TourScreen, noteId: string): boolean {
  if (screen === "list") return document.querySelector("[data-phone-list-shown]") !== null;
  return getTourNoteEditor(noteId) !== null || document.querySelector("input[data-note-title-input]") !== null;
}

const IDLE: EngineSnapshot = { phase: "idle", index: -1, total: 0, entry: null, pending: false, preparing: null, endReason: null };
const subscribeNothing = () => () => {};
const idleSnapshot = () => IDLE;

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * One `TourOverlay` for the whole round: a step change swaps its content in place so its persistent live region announces the change; a remount would treat every step as just opened.
 * Start: close the drawer and wait for it to leave the DOM (it is modal: the card is unreachable and targets unfindable). AI actions are read in parallel with `prepareSample`; the editor is usually editable by the time the read is done, so writing the sample needn't wait another round trip (typing into the empty note meanwhile makes the write give up).
 * The start flow runs in a mount effect and checks the abort signal after every step: StrictMode's mount-unmount-mount stops the first round before it creates the sample, so two notes aren't created.
 * That relies on an `await` (the drawer wait) before the first abort check: round one's cleanup runs before it returns; a start that doesn't yield would create the sample first.
 * Leaving ends the tour without resuming and keeps the sample note. Back/forward (POP) counts as leaving: screen changes replace history, so a POP can land on the same path's list; hence the navigation type is checked, not only the path.
 * [Delete] trashes only after navigating away: deleting the open note would make the note page run its "deleted" handling.
 */
export function TourRunner({ returnTo, returnFocus, prepareSample, onStarted, onFinished, stops }: TourRunnerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { query } = useSidebarQuery();
  const deleteNote = useDeleteNote();
  const layout = useTourLayout();
  const [run, setRun] = useState<Run | null>(null);
  // A counter: a breakpoint crossing and a step change can overlap; > 0 hides the card.
  const [switchCount, setSwitchCount] = useState(0);
  const switching = switchCount > 0;
  const navigateRef = useRef(navigate);
  const locationRef = useRef(location);
  useEffect(() => {
    navigateRef.current = navigate;
    locationRef.current = location;
  });
  const expectedPathRef = useRef<string | null>(null);

  const readQuery = useEffectEvent(() => query);

  const startFlow = useEffectEvent(async (signal: AbortSignal) => {
    getShellControls()?.closeDrawer();
    await waitForDrawerClosed(signal);
    if (signal.aborted) return;
    const tab = getShellControls()?.getTab() ?? null;
    // Sent after the drawer-wait await: StrictMode's first round stops there, so it doesn't read twice.
    const aiRead = fetchTourAiActions(queryClient);
    let note: NoteDto | null = null;
    try {
      note = await prepareSample(signal, aiRead);
    } catch (err) {
      console.error(err);
    }
    if (signal.aborted) return;
    if (note === null) {
      onFinished({ started: false, reason: "aborted" });
      return;
    }
    const aiActions = await aiRead;
    if (signal.aborted) return;
    const notePath = canonicalNotePath(note);
    const noteId = note.id;
    expectedPathRef.current = notePath;
    let engine: TourEngine | null = null;
    const showScreen = async (screen: TourScreen, screenSignal: AbortSignal): Promise<void> => {
      const path = screen === "list" ? LIST_PATH : notePath;
      expectedPathRef.current = path;
      const ready = () => samePath(locationRef.current.pathname, path) && screenReady(screen, noteId);
      if (ready()) return;
      setSwitchCount((n) => n + 1);
      try {
        if (!samePath(locationRef.current.pathname, path)) void navigateRef.current(path, { replace: true });
        const shown = await waitForFrames(() => (ready() ? true : null), screenSignal, SCREEN_TIMEOUT_MS);
        if (shown === null && !screenSignal.aborted && screen === "note") engine?.end("left");
        // Steps on the list start at the top (the tab bar isn't pinned, so it's out of view when the list is scrolled).
        if (shown !== null && screen === "list" && window.scrollY > 0) window.scrollTo(0, 0);
      } finally {
        setSwitchCount((n) => n - 1);
      }
    };
    const ctx: StopContext = { searchQuery: readQuery(), aiActions, sampleNoteId: noteId, liveStops: canRunLiveStop(noteId), showScreen };
    const planned = planStops(stops ?? fullTourStops(), ctx);
    engine = new TourEngine(planned, ctx);
    setRun({ engine, stops: planned, note, path: notePath, tab, ctx });
  });

  useEffect(() => {
    const controller = new AbortController();
    void startFlow(controller.signal);
    return () => controller.abort();
  }, []);

  const snapshot = useSyncExternalStore(run?.engine.subscribe ?? subscribeNothing, run?.engine.getSnapshot ?? idleSnapshot);

  // On every location change, check it is still the expected screen (the sample note, or the list for phone list steps); search/hash-only changes (e.g. presentation mode's `?present`) don't count as leaving. Back/forward (POP) always counts: the tour's own screen changes replace history and never produce a POP.
  // Placed before the effect that enters step 1: if already off the sample note at start, don't enter.
  // Real navigation type: the tour lives at App level, outside the `<Routes>` that carries `location`, so `useNavigationType()` is real; if it moved into such a tree (type always POP), read `RealLocationContext` first.
  const realNavigationType = useRealNavigationType();
  const routerNavigationType = useNavigationType();
  const navigationType = realNavigationType ?? routerNavigationType;
  const seenKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (run === null || run.engine.getSnapshot().phase === "ended") return;
    const seen = seenKeyRef.current;
    seenKeyRef.current = location.key;
    if (seen !== null && seen !== location.key && navigationType === NavigationType.Pop) {
      run.engine.end("left");
      return;
    }
    if (!samePath(location.pathname, expectedPathRef.current ?? run.path)) run.engine.end("left");
  }, [location.key, location.pathname, navigationType, run]);

  useEffect(() => {
    if (run === null) return;
    void run.engine.begin();
    return () => run.engine.end("unmount");
  }, [run]);

  // The "step 1 appeared" signal is sent once: the ref lives with the component instance, so StrictMode's simulated remount, re-renders and going back don't resend it.
  const startedRef = useRef(false);
  const notifyStarted = useEffectEvent(() => onStarted?.());
  useEffect(() => {
    if (snapshot.index < 0 || startedRef.current) return;
    startedRef.current = true;
    notifyStarted();
  }, [snapshot.index]);

  // After navigating back wait for the new location to take effect (new sidebar mounted) before looking for the trigger: too early finds the one in the old sidebar about to unmount.
  const locationKeyRef = useRef(location.key);
  useEffect(() => {
    locationKeyRef.current = location.key;
  }, [location.key]);

  const trashSample = useEffectEvent(async (note: NoteDto) => {
    try {
      await deleteNote.mutateAsync(note.id);
      showTrashedToast({ notes: [note], queryClient, navigate, t, reopen: false });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  });

  const finish = useEffectEvent(async (reason: EndReason, signal: AbortSignal) => {
    if (run === null) return;
    const restoreTab = (options?: { reveal?: boolean }) => {
      if (run.tab === null) return;
      const shell = getShellControls();
      if (shell !== null && shell.getTab() !== run.tab) shell.showTab(run.tab, options);
    };
    const phone = tourLayout() === "phone";
    // Not with a floating sidebar: switching tab would open the drawer.
    if (tourLayout() === "wide") restoreTab();
    // Phone: back to the list on complete/close (the avatar is there). Based on the path the tour should be on, not the on-screen location: at the end it may be mid-switch from list to sample note whose navigation hasn't taken effect, so the screen still shows the list.
    // Already on the list and not switching screens → no navigation. On `left` the user went elsewhere themselves → none.
    // Other layouts: if still on the sample note go back to `returnTo` (recorded before the sample note was created, so never the sample note).
    const leave = phone
      ? reason !== "left" && !(samePath(location.pathname, LIST_PATH) && expectedPathRef.current === LIST_PATH)
      : samePath(location.pathname, run.path);
    if (leave) {
      const from = locationKeyRef.current;
      // Replaces the sample note's history entry: after [Delete], Back won't return to the trashed sample note.
      void navigate(phone ? LIST_PATH : returnTo, { replace: true });
      await waitForFrames(() => (locationKeyRef.current !== from ? true : null), signal, RETURN_FOCUS_TIMEOUT_MS);
      if (signal.aborted) return;
    }
    // Phone only switches tab without a screen: if the user went to another note or the login page, don't pull them back to the list.
    if (phone) restoreTab({ reveal: false });
    await Promise.all([focusReturnTarget(returnFocus, signal), reason === "delete" ? trashSample(run.note) : null]);
    if (signal.aborted) return;
    const started = run.engine.getSnapshot().index >= 0;
    onFinished({ started, reason: finishReason(reason, started) });
  });

  useEffect(() => {
    const reason = snapshot.endReason;
    if (snapshot.phase !== "ended" || reason === null || reason === "unmount") return;
    const controller = new AbortController();
    void finish(reason, controller.signal);
    return () => controller.abort();
  }, [snapshot.phase, snapshot.endReason]);

  // The cutout is re-measured every frame: window resize, scroll, DOM changes and crossing the layout breakpoint (target becomes the sidebar button or "‹") all move it;
  // the edge bands the card avoids (phone header, round buttons) are measured too. Measure once in a layout effect on entering a step, so no frame shows a card without a cutout.
  const entry = snapshot.phase === "running" ? snapshot.entry : null;

  // Crossing 640 mid-tour: re-show the on-screen step for the new layout (e.g. sidebar-floating → phone: a list step must return to the list). Not while switching steps: the engine switches itself.
  const pending = snapshot.pending;
  useEffect(() => {
    const show = run?.ctx.showScreen;
    if (entry === null || pending || show === undefined) return;
    const controller = new AbortController();
    void show(stopScreen(entry.stop, layout), controller.signal);
    return () => controller.abort();
  }, [run, entry, pending, layout]);

  const [target, setTarget] = useState<Rect | null>(null);
  const [bands, setBands] = useState<CardBands>({ keepOut: NO_INSETS, blocked: NO_INSETS });
  useLayoutEffect(() => {
    if (entry === null || run === null) return;
    let frame = 0;
    const measure = () => {
      const now = tourLayout();
      const next = measureTargets(stopTarget(entry.stop, run.ctx, now));
      setTarget((prev) => (sameRect(prev, next) ? prev : next));
      const nextBands = measureCardBands(now);
      setBands((prev) => (sameInsets(prev.keepOut, nextBands.keepOut) && sameInsets(prev.blocked, nextBands.blocked) ? prev : nextBands));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [entry, run]);

  // Live demo step: focus stays in the editor; keyboard and menu clicks are taken over by the tour (see `installLiveStopInput`).
  // The card's look follows the on-screen step; interception follows the step being prepared: when entering the demo step the menu was already open before the target appears.
  const liveStop = entry !== null && run !== null && entry.stop.live?.(run.ctx) === true;
  const preparing = snapshot.phase === "running" ? snapshot.preparing : null;
  const liveInput = liveStop || (preparing !== null && run !== null && preparing.stop.live?.(run.ctx) === true);
  useEffect(() => {
    if (!liveInput || run === null) return;
    const { engine } = run;
    return installLiveStopInput({ next: () => engine.next(), back: () => engine.back() });
  }, [liveInput, run]);

  if (entry === null || run === null) return null;
  const { engine } = run;
  const { step, total } = tourProgress(run.stops, snapshot.index, layout);
  return (
    <TourOverlay
      target={switching ? null : target}
      hidden={switching}
      keepOut={bands.keepOut}
      blocked={bands.blocked}
      live={liveStop}
      stopKey={snapshot.index}
      step={step}
      total={total}
      title={stopTitle(t, entry.stop, layout)}
      body={stopBody(t, entry.stop, layout)}
      onNext={() => engine.next()}
      onBack={() => engine.back()}
      onSkip={() => engine.end("close")}
      onClose={() => engine.end("close")}
      onKeep={() => engine.end("keep")}
      onDelete={() => engine.end("delete")}
    />
  );
}
