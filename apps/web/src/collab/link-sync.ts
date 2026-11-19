import * as Y from "yjs";
import { extractLinkTargets } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { canEdit, type CollabState } from "./connection";

const DEBOUNCE_MS = 2_000;
const NOT_LOADED_RETRY_MS = 1_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// Injected rather than importing `api()` so tests can fake fetch / timers.
export type LinkSyncApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface CreateLinkSyncOptions {
  noteId: string;
  doc: Y.Doc;
  api: LinkSyncApiFn;
}

export interface LinkSync {
  start(): void;
  stop(): void;
  onCollabState(state: CollabState): void;
  onSynced(): void;
}

type Latch = "none" | "403" | "400";

interface RetryState {
  key: string;
  notLoadedUsed: boolean;
  /** Delay for the next failure, not the one already scheduled. */
  backoffMs: number;
}

// At most one request in flight: a trigger while one runs only sets `resubmitPending` and recomputes after it lands, so two POSTs never race over `lastSubmittedKey`.
export function createLinkSync({ noteId, doc, api }: CreateLinkSyncOptions): LinkSync {
  let started = false;
  let inFlight = false;
  let resubmitPending = false;
  /**
   * Before the first `onSynced()`, `update` events may be the handshake catch-up, so a debounce-computed set can be half-caught-up. `POST .../links` replaces the whole set
   * (`attemptOnce` in `apps/server/src/notes/links.ts`), so sending it would delete links that merely haven't synced: with an almost-empty `Y.Doc` it clears all of the note's links.
   * Hence the first submit is always the one `onSynced()` triggers (`start()` doesn't submit).
   */
  let hasSyncedOnce = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryState: RetryState | null = null;

  let lastSubmittedKey: string | null = null;

  let latch: Latch = "none";
  let latch400Key: string | null = null;

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs: number): void {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptSubmit();
    }, delayMs);
  }

  function handleFailure(err: unknown, key: string): void {
    if (!started) return; // a response landing after stop(): the state machine is moot, do nothing

    if (err instanceof ApiFail && err.status === 403) {
      latch = "403";
      retryState = null;
      return;
    }

    if (err instanceof ApiFail && err.status === 400) {
      latch = "400";
      latch400Key = key;
      retryState = null;
      toast({
        title: i18n.t(`errors.${err.code}`, { defaultValue: i18n.t("errors.fallback") }),
        variant: "destructive",
      });
      return;
    }

    if (err instanceof ApiFail && err.status === 409 && err.code === "not_loaded") {
      const alreadyUsed = retryState?.key === key && retryState.notLoadedUsed;
      if (alreadyUsed) {
        retryState = null;
        return;
      }
      retryState = { key, notLoadedUsed: true, backoffMs: INITIAL_BACKOFF_MS };
      scheduleRetry(NOT_LOADED_RETRY_MS);
      return;
    }

    // Every other ApiFail (5xx, a 409 other than not_loaded) and non-ApiFail (network failure / non-JSON 2xx; see `isRetryableTokenError` in `useCollab.ts`) is transient: same exponential backoff.
    const previous = retryState?.key === key ? retryState : null;
    const delayMs = previous?.backoffMs ?? INITIAL_BACKOFF_MS;
    retryState = {
      key,
      notLoadedUsed: previous?.notLoadedUsed ?? false,
      backoffMs: Math.min(delayMs * 2, MAX_BACKOFF_MS),
    };
    scheduleRetry(delayMs);
  }

  function send(targets: string[], key: string): void {
    inFlight = true;
    void api<void>(`/api/notes/${encodeURIComponent(noteId)}/links`, {
      method: "POST",
      body: JSON.stringify({ link_target_ids: targets }),
    }).then(
      () => {
        inFlight = false;
        lastSubmittedKey = key;
        retryState = null;
        settleFollowup();
      },
      (err: unknown) => {
        inFlight = false;
        handleFailure(err, key);
        settleFollowup();
      },
    );
  }

  function settleFollowup(): void {
    if (!resubmitPending) return;
    resubmitPending = false;
    attemptSubmit();
  }

  /**
   * Check `retryTimer`, not just `retryState`: after a retry timer fires and before the next failure is processed, `retryState` still holds the same key (`handleFailure` uses it for the next backoff),
   * so judging by key alone would make the timer's own `attemptSubmit()` (`retryTimer` already null, see `scheduleRetry`) return as "already scheduled" and never send.
   */
  function attemptSubmit(): void {
    if (!started || !hasSyncedOnce || latch === "403") return;

    const targets = extractLinkTargets(doc);
    const key = targets.join(",");

    if (latch === "400") {
      if (key === latch400Key) return;
      latch = "none";
      latch400Key = null;
    }

    if (key === lastSubmittedKey) return;

    if (inFlight) {
      resubmitPending = true;
      return;
    }

    if (retryTimer && retryState?.key === key) return; // a retry for the same set is already scheduled; leave it to that
    if (retryState && retryState.key !== key) {
      clearRetryTimer();
      retryState = null;
    }

    send(targets, key);
  }

  function onDocUpdate(): void {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      attemptSubmit();
    }, DEBOUNCE_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      doc.on("update", onDocUpdate);
    },

    stop() {
      started = false;
      hasSyncedOnce = false;
      doc.off("update", onDocUpdate);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearRetryTimer();
      retryState = null;
      resubmitPending = false;
    },

    onCollabState(state: CollabState) {
      // Repeated calls are no-ops when `latch !== "403"`, so no edge detection is needed.
      if (latch === "403" && state.phase === "connected" && canEdit(state.role)) {
        latch = "none";
        attemptSubmit();
      }
    },

    onSynced() {
      if (!started) return;
      hasSyncedOnce = true;
      // A reconnect's synced also resets the cache, so the set is resent once even if identical to the last submit.
      lastSubmittedKey = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearRetryTimer();
      retryState = null;
      attemptSubmit();
    },
  };
}
