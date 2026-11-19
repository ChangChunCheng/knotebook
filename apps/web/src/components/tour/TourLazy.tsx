import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";
import "@/i18n/tour-strings";
import type { TourStartOptions } from "@/lib/tour-context";
import { getTourNoteEditor, onEditorEditable, type TourEditor } from "@/lib/tour-bridge";
import { focusReturnTarget, RETURN_FOCUS_TIMEOUT_MS, samePath, waitForFrames } from "./engine";
import { createSampleNote, seedSampleNote } from "./sample-note";
import { TourRunner, type TourResult } from "./TourRunner";


export interface TourLazyProps extends TourStartOptions {
  /** Past the start limit since the press: abort if step 1 hasn't appeared yet. */
  timedOut: boolean;
  /** Called once when step 1 appears. */
  onStarted: () => void;
  /** Called once when the round ends (finished or aborted); afterwards "active" is cleared. */
  onDone: () => void;
}

/** One value shared by abort and write: writing happens only while `preparing`, abort moves it to `aborted` only when not `seeded`, so a read returning after abort doesn't write and a written note isn't discarded as blank. */
type SamplePhase = "preparing" | "seeded" | "aborted";

interface Session {
  phase: SamplePhase;
  note: NoteDto | null;
  /** A failure toast was already shown (create or start failed): at most one per round. */
  notified: boolean;
  started: boolean;
  /** Reached the sample note's page once: only after that does leaving it count as leaving. */
  arrived: boolean;
  /** End or abort handling has started. */
  ending: boolean;
  /** Set once abort has decided what happens to the sample note (including sending the one to move). Before that abort trashes it (after navigating back); a POST returning later is moved by `prepareSample` itself. */
  settled: boolean;
  /** The sample note was already sent to trash. */
  discarded: boolean;
}

const NEVER = new AbortController().signal;

function describeError(t: TFunction, err: unknown): string | undefined {
  return err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : undefined;
}

function waitForEditableEditor(noteId: string, signal: AbortSignal): Promise<TourEditor | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let unsubscribe = () => {};
    const finish = (editor: TourEditor | null) => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(editor);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort);
    unsubscribe = onEditorEditable((id, editor) => {
      if (id === noteId) finish(editor);
    });
    // An instance that was already editable before subscribing gets no replay.
    const current = getTourNoteEditor(noteId);
    if (current?.isEditable) finish(current);
  });
}

export function TourLazy({ returnTo, returnFocus, timedOut, onStarted, onDone }: TourLazyProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteNote = useDeleteNote();
  const [runnerMounted, setRunnerMounted] = useState(true);
  const sessionRef = useRef<Session>({
    phase: "preparing",
    note: null,
    notified: false,
    started: false,
    arrived: false,
    ending: false,
    settled: false,
    discarded: false,
  });
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  /** No trash toast (the start-failure one already said it); sent once. After abort the component may be unmounted and this still runs. */
  const discard = (note: NoteDto) => {
    const session = sessionRef.current;
    if (session.discarded) return;
    session.discarded = true;
    deleteNote.mutateAsync(note.id).catch((err: unknown) => console.error(err));
  };

  /**
   * If the note to move is open, navigate back first and wait for the location to take effect: trashing an open note sends the note page through its "deleted" exit and a second toast.
   * Tearing down `TourRunner` aborts `prepareSample`, whose `bail` runs before the back-navigation transition; while this runs (`ending` and not yet `settled`) only this trashes and `bail` doesn't.
   * Focus returns to `returnFocus` also when the user navigated away themselves (same as normal end).
   */
  const abortStart = async () => {
    const session = sessionRef.current;
    if (session.ending) return;
    session.ending = true;
    const keep = session.phase === "seeded";
    if (!keep) session.phase = "aborted";
    if (!session.notified) {
      session.notified = true;
      toast({ title: t("tourGuide.startFailed"), variant: "destructive" });
    }
    setRunnerMounted(false);
    const note = session.note;
    if (!keep && note !== null) {
      if (samePath(locationRef.current.pathname, canonicalNotePath(note))) {
        const from = locationRef.current.key;
        void navigate(returnTo, { replace: true });
        await waitForFrames(() => (locationRef.current.key !== from ? true : null), NEVER, RETURN_FOCUS_TIMEOUT_MS);
      }
      discard(note);
    }
    session.settled = true;
    await focusReturnTarget(returnFocus, NEVER);
    onDone();
  };
  const abortFromEffect = useEffectEvent(() => void abortStart());

  /** Checks for abort after every await: once aborted nothing is written, and the created note is moved to trash (including one whose POST hadn't returned at abort). */
  const prepareSample = async (signal: AbortSignal, aiActions: Promise<AiActionDto[]>): Promise<NoteDto | null> => {
    const session = sessionRef.current;
    const stopped = () => session.phase === "aborted" || signal.aborted;
    const bail = () => {
      if (session.phase !== "seeded") session.phase = "aborted";
      if (session.note !== null && session.phase === "aborted" && (!session.ending || session.settled)) discard(session.note);
      return null;
    };
    if (stopped()) return null;
    let note: NoteDto;
    try {
      note = await createSampleNote(queryClient, t);
    } catch (err) {
      console.error(err);
      if (!stopped() && !session.notified) {
        session.notified = true;
        toast({ title: t("tourGuide.sampleFailed"), description: describeError(t, err), variant: "destructive" });
      }
      return null;
    }
    session.note = note;
    if (stopped()) return bail();
    // Subscribing to "editable" and reading the current value both happen in waitForEditableEditor, so calling before or after navigation can't miss the notification.
    const editable = waitForEditableEditor(note.id, signal);
    void navigate(canonicalNotePath(note));
    const editor = await editable;
    if (editor === null || stopped()) return bail();
    const titleShown = await waitForFrames(() => document.querySelector("input[data-note-title-input]"), signal);
    if (titleShown === null || stopped()) return bail();
    const actions = await aiActions;
    if (stopped()) return bail();
    try {
      seedSampleNote(editor, note, t, actions.length > 0);
    } catch (err) {
      // Document still empty: stay `preparing`, so abort trashes it as a blank note.
      console.error(err);
      return null;
    }
    session.phase = "seeded";
    return note;
  };

  // Before the sample is written, leaving the sample note (e.g. clicking another note in the sidebar) = abort. After it, screen changes are `TourRunner`'s; leaving the screen it should be on
  // also ends there (step 1 not yet shown still reports `started: false` and aborts here).
  useEffect(() => {
    const session = sessionRef.current;
    if (session.started || session.ending || session.note === null || session.phase === "seeded") return;
    if (samePath(location.pathname, canonicalNotePath(session.note))) session.arrived = true;
    else if (session.arrived) abortFromEffect();
  }, [location.pathname]);

  // Whether to abort on timeout is decided by `started` here: after step 1 commits, `handleStarted` runs before the next render, so the `started` seen here is already true.
  // TourProvider stopping its timer on `onStarted` only clears a timer that's no longer needed.
  useEffect(() => {
    if (timedOut && !sessionRef.current.started) abortFromEffect();
  }, [timedOut]);

  const handleStarted = () => {
    sessionRef.current.started = true;
    onStarted();
  };

  const handleFinished = (result: TourResult) => {
    if (!result.started) {
      void abortStart();
      return;
    }
    sessionRef.current.ending = true;
    onDone();
  };

  if (!runnerMounted) return null;
  return (
    <TourRunner
      returnTo={returnTo}
      returnFocus={returnFocus}
      prepareSample={prepareSample}
      onStarted={handleStarted}
      onFinished={handleFinished}
    />
  );
}
