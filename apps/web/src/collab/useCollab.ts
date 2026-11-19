import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_CLIENT_OUTDATED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_RESTART_DELAYS_MS,
  COLLAB_RESTART_JITTER,
  COLLAB_TOKEN_RETRY_DELAYS_MS,
  NOTE_SCHEMA_VERSION,
  type Role,
} from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { COLLAB_CLOSE_CLIENT_OUTDATED, collabReducer, INITIAL_COLLAB_STATE, stopsReconnect, type CollabEvent, type CollabState } from "./connection";

export interface CollabTokenResponse {
  token: string;
  /** Authoritative role source. Never decode the JWT: it is a credential between the server and Hocuspocus. */
  role: Role;
}

// Path must match the server's COLLAB_PATH (dev: Vite proxies /collab with ws: true).
export function collabUrl(location: { protocol: string; host: string } = window.location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collab`;
}

/**
 * Backoff for the token function (ms), used for 5xx/429/network errors: "can't get a token now"
 * is not an authorization failure and must not kick or log out; 401 is the exception (session
 * gone, no retry). Defined in shared: the server's revocation re-validation deadline is
 * deliberately shorter than their sum (fail-closed) and the delete-gate TTL assumes it
 * (`useCollab.test.tsx` pins the deadline).
 */
const TOKEN_RETRY_DELAYS_MS = COLLAB_TOKEN_RETRY_DELAYS_MS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Max wait for our own close after entering `reconnecting-once`; on timeout, reconnect anyway. */
const RECONNECT_FALLBACK_MS = 1_000;

/**
 * Whole-connection retry (ms) after the token backoff is exhausted or a non-authorization
 * rejection (#39, #35): the provider then neither closes the socket nor fetches a token, so
 * nothing else recovers. An order of magnitude longer than the token backoff (that 7.5 s round
 * already showed it is not a blip; don't hammer a failing server); the last entry repeats, so it
 * never gives up (slow beats stopping). Capped at 60 s
 * and jittered: the collab-token limit is one per-user 60/min bucket across tabs
 * (`COLLAB_TOKEN_LIMIT` on the server), and a fixed 30 s plus the 7.5 s token backoff would be
 * 5 requests per 37.5 s, so 8 tabs alone would make 64 req/min; a server restart also hits all
 * tabs at once. The server's delete-gate TTL must cover the maximum, or a deleted note
 * reconnects as "you lost access" (#35).
 */
const TOKEN_RESTART_DELAYS_MS = COLLAB_RESTART_DELAYS_MS;

const RESTART_JITTER = COLLAB_RESTART_JITTER;

function jittered(delay: number): number {
  return Math.round(delay * (1 + (Math.random() * 2 - 1) * RESTART_JITTER));
}

/**
 * The `"close"` listener issues the reconnect once our own close arrives (see `useCollab`).
 *
 * The fallback must not clear the pending flag (#34): `connect()` returns early while status is
 * still `Connected`, so clearing it made the late close look like an ordinary disconnect and
 * nobody reconnected. Cost: one extra swallowed close while the socket is open but
 * unauthenticated; harmless (followed by `connect()`, flag cleared). When the close was on time
 * the flag is already false and the fallback must stay a no-op: its `connect()` would tear down
 * the socket being created.
 */
function restartConnection(provider: HocuspocusProvider, pendingReconnectRef: { current: boolean }): () => void {
  pendingReconnectRef.current = true;
  provider.disconnect();
  const fallback = setTimeout(() => {
    if (!pendingReconnectRef.current) return;
    void provider.connect();
  }, RECONNECT_FALLBACK_MS);
  return () => clearTimeout(fallback);
}

// Network failures and a non-JSON 2xx throw a plain Error, not ApiFail: treat as transient.
function isRetryableTokenError(err: unknown): boolean {
  if (err instanceof ApiFail) return err.status === 429 || err.status >= 500;
  return true;
}

/**
 * Must exceed the server's persist debounce (2 s, `maxDebounce` 10 s, `STORE_DEBOUNCE_MS`): the
 * re-fetch reads `last_edited_*`, written only after `onStoreDocument` (#106). The timers start
 * at different moments, so the margin is about 1 s minus network and persist time; if exceeded,
 * the re-fetch returns the old value until the next edit or window focus.
 */
const DOC_UPDATE_DEBOUNCE_MS = 3_000;

/**
 * Counts both remote updates (origin = the provider) and local typing (origin =
 * `ySyncPluginKey`): the server also writes `last_edited_*` for the user's own typing (#138).
 * Guarded by `useCollab.doc-update.test.ts`.
 */
export function createDocUpdateDebouncer(doc: Y.Doc, onDocUpdate: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handleUpdate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onDocUpdate, delayMs);
  };
  doc.on("update", handleUpdate);
  return () => {
    doc.off("update", handleUpdate);
    if (timer) clearTimeout(timer);
  };
}

export interface UseCollabOptions {
  /** Note uuid, not a slug or canonical ref; undefined = not resolved yet (no connection). */
  noteId: string | undefined;
  onUnauthorized: () => void;
  /** Debounced; excludes the initial sync batch. Invalidating the note query is the caller's job (this hook doesn't touch the router or query cache). */
  onDocUpdate?: () => void;
}

export interface UseCollabResult {
  state: CollabState;
  /** Created inside the effect so StrictMode can tear it down correctly. */
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  /**
   * Sticky across disconnects (offline edits after a first sync are legitimately merged back,
   * #39); reset on note change, where the new empty Y.Doc looks like a blank note: callers use
   * it to block typing into one that vanishes on reload (#48).
   */
  synced: boolean;
  /**
   * #269: the paragraph anchor is consumed on this, not `synced`: `synced` resets only at the
   * start of the new note's connection effect, so the first commit of A → B still carries A's
   * `synced === true`.
   */
  syncedFor: string | null;
}

/**
 * Do not pass `websocketProvider`: with a shared socket `provider.disconnect()` is a no-op and
 * revocation stops working. Never enable `sessionAwareness`: the server indexes connections by
 * `(socketId, documentName)`, and documentName would end up in the sessionId and collide (see
 * the header of `apps/server/src/collab/server.ts`).
 *
 * Use `provider.on("close")`, not `onClose` in the configuration: with a self-managed socket the
 * same configuration is handed to the internal `HocuspocusProviderWebsocket`, so `onClose` is
 * registered twice and fires twice per socket close. The callback receives both the
 * application-level CLOSE message (code 1000, reason `COLLAB_CLOSE_*`) and the underlying
 * WebSocket close (reason usually empty); only the reason is looked at.
 *
 * `connect()` must not be called synchronously after `disconnect()`: it only requests the close,
 * status is still `Connected`, and `HocuspocusProviderWebsocket.connect()` returns early without
 * setting `shouldConnect`, so the built-in backoff never starts and the second strike never
 * happens. Issue it in the close listener's branch that swallows our own close: the websocket
 * provider's own close listener (registered first, in its constructor) has already cleared
 * `webSocket` and set status to `Disconnected`.
 */
export function useCollab({ noteId, onUnauthorized, onDocUpdate }: UseCollabOptions): UseCollabResult {
  const [state, setState] = useState<CollabState>(INITIAL_COLLAB_STATE);
  const [session, setSession] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [synced, setSynced] = useState(false);
  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  // Set as soon as the provider is created: the side-effect effect can't wait for `setSession`'s re-render.
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const roleRef = useRef<Role>("none");
  const pendingReconnectRef = useRef(false);
  const stopRestartsRef = useRef<(() => void) | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  // Via a ref so a new callback identity per caller render doesn't rebuild the connection (deps stay `[noteId, dispatch]`).
  const onDocUpdateRef = useRef(onDocUpdate);
  onDocUpdateRef.current = onDocUpdate;

  const dispatch = useCallback((event: CollabEvent) => {
    setState((prev) => collabReducer(prev, event));
  }, []);

  useEffect(() => {
    if (!noteId) return;

    setState(INITIAL_COLLAB_STATE);
    setSynced(false);
    setSyncedFor(null);
    roleRef.current = "none";
    pendingReconnectRef.current = false;

    let disposed = false;
    /**
     * The latest token call threw. When `getToken()` throws the provider calls
     * `permissionDeniedHandler`, so `authenticationFailed` also fires for our own 5xx/network
     * failures, which isn't an authorization verdict; only we can tell them apart.
     * Local to the effect, not a hook-level ref: a destroyed connection's token request still in
     * backoff (up to 7.5 s) throws on return; a shared flag would be set to true with no listener
     * left to clear it, then swallow the next connection's real revocation (#6).
     */
    let tokenFetchFailed = false;
    /** The latest token failure is final (401: logout started; 404: converged to deleted); a restart would only spend another collab-token request. */
    let tokenFailureFinal = false;
    let restartAttempt = 0;
    const doc = new Y.Doc();

    const fetchTokenWithRetries = async (): Promise<string> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          // The server signs the note schema version into the token as `sv` and compares it at handshake (#269).
          const body = await api<CollabTokenResponse>(`/api/notes/${encodeURIComponent(noteId)}/collab-token`, {
            method: "POST",
            body: JSON.stringify({ noteSchemaVersion: NOTE_SCHEMA_VERSION }),
          });
          // Needs the `disposed` guard too (#36): `roleRef`/`dispatch` are hook-level, so a late
          // response would hit the new note's state machine; the previous note's role `'none'`
          // arriving while the new note is in `reconnecting-once` would count as the second strike.
          // Returns the token rather than throwing: the recipient is the destroyed provider, and
          // throwing would just go through the `tokenFetchFailed` path again.
          if (disposed) return body.token;
          roleRef.current = body.role;
          dispatch({ type: "token-role", role: body.role });
          return body.token;
        } catch (err) {
          if (err instanceof ApiFail && err.status === 401) {
            // No `disposed` guard (unlike 404 and success, #36): 401 invalidates the whole session,
            // so even a late one must log the user out.
            tokenFailureFinal = true;
            onUnauthorizedRef.current();
            throw err;
          }
          if (err instanceof ApiFail && err.status === 404) {
            // Safety net: today the token endpoint returns 200 + role 'none' for an inaccessible or
            // deleted note (`routes/notes.ts`), but converge correctly if that contract changes.
            // Guarded like #36: a late 404 belongs to the previous note.
            tokenFailureFinal = true;
            if (!disposed) dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
            throw err;
          }
          const delay = TOKEN_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isRetryableTokenError(err) || disposed) throw err;
          await sleep(delay);
        }
      }
    };

    // Records a failed fetch so `authenticationFailed` can tell "couldn't get a token" from "the
    // server refused"; cleared on entry so a success leaves no residue that swallows a later real rejection.
    const fetchToken = async (): Promise<string> => {
      tokenFetchFailed = false;
      tokenFailureFinal = false;
      try {
        return await fetchTokenWithRetries();
      } catch (err) {
        tokenFetchFailed = true;
        throw err;
      }
    };

    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: noteId,
      document: doc,
      token: fetchToken,
      onAuthenticated: () => {
        pendingReconnectRef.current = false;
        restartAttempt = 0;
        // Also cancel a scheduled restart: it would tear down a connection the provider's own
        // backoff already healed and waste per-user collab-token quota shared across tabs.
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        restartTimer = undefined;
        cancelRestartFallback?.();
        cancelRestartFallback = undefined;
        dispatch({ type: "open", role: roleRef.current });
      },
    });

    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelRestartFallback: (() => void) | undefined;
    let restartsStopped = false;
    const scheduleRestart = () => {
      if (disposed || restartsStopped || restartTimer !== undefined) return;
      const index = Math.min(restartAttempt, TOKEN_RESTART_DELAYS_MS.length - 1);
      restartAttempt += 1;
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (disposed) return;
        cancelRestartFallback?.();
        cancelRestartFallback = restartConnection(provider, pendingReconnectRef);
      }, jittered(TOKEN_RESTART_DELAYS_MS[index]!));
    };

    // `synced` only fires on the false→true edge, so the handler only sets true (sticky, see `UseCollabResult.synced`).
    // No initial `provider.synced` check: this provider is brand new and connect() is async, so it
    // can't be synced yet (unlike NotePage's guard, whose provider comes from state). No explicit
    // unsubscribe: provider.destroy()'s removeAllListeners does it.
    // The doc-update debounce (#106) attaches inside "synced", not the effect body, or the initial
    // sync batch would invalidate the note query on page open; `??=` keeps a reconnect from
    // attaching twice. Guard: the "initial sync batch doesn't count" test.
    let disposeDocUpdate: (() => void) | undefined;
    provider.on("synced", () => {
      setSynced(true);
      if (!disposed) setSyncedFor(noteId);
      disposeDocUpdate ??= createDocUpdateDebouncer(doc, () => onDocUpdateRef.current?.(), DOC_UPDATE_DEBOUNCE_MS);
    });

    provider.on("close", ({ event }: { event?: { reason?: string } }) => {
      const reason = event?.reason ?? "";
      const isAppLevel = reason === COLLAB_CLOSE_REVOKED || reason === COLLAB_CLOSE_NOTE_DELETED;
      if (!isAppLevel && pendingReconnectRef.current) {
        // Our own disconnect()'s close: feeding it to the state machine would knock reconnecting-once
        // back to connecting and reset the revocation window. Reconnect here (see the useCollab doc).
        pendingReconnectRef.current = false;
        void provider.connect();
        return;
      }
      dispatch({ type: "close", reason });
    });

    // #6: revocation before the handshake completes makes `onAuthenticate` throw instead of sending
    // CLOSE(REVOKED), and Hocuspocus 4.5.0 then only sends permission-denied: no close, no reconnect,
    // and `token-role: 'none'` deliberately doesn't transition in `connecting`. Without this handler
    // the user is stuck on "connecting".
    provider.on("authenticationFailed", ({ reason }: { reason?: string }) => {
      if (tokenFetchFailed) {
        // Not a verdict; restart, since nothing else will fetch a new token (#39).
        tokenFetchFailed = false;
        if (!tokenFailureFinal) scheduleRestart();
        return;
      }

      // Coerce to a string first: an absent reason on both sides would compare equal and misclassify an unknown rejection as "note deleted".
      const wire = typeof reason === "string" ? reason : "";

      // #35: group A, the only authorization verdicts. forbidden reuses the two-strike REVOKED path so a
      // one-off server hiccup doesn't kick a legitimate user; note-deleting is final.
      // #269: the stale-tab gate is neither a verdict nor transient (a retry gets the same answer), so
      // it goes to `outdated`; the stopsReconnect effect below stops restarts and disconnects.
      if (wire === COLLAB_REJECT_CLIENT_OUTDATED) {
        dispatch({ type: "close", reason: COLLAB_CLOSE_CLIENT_OUTDATED });
        return;
      }
      if (wire === COLLAB_REJECT_NOTE_DELETING) {
        dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
        return;
      }
      if (wire === COLLAB_REJECT_FORBIDDEN) {
        dispatch({ type: "close", reason: COLLAB_CLOSE_REVOKED });
        return;
      }

      // Group B: `invalid-token`/`server-error`/unrecognized reasons (including the literal
      // `"permission-denied"` Hocuspocus uses for unexpected exceptions) don't mean "no
      // permission"; mapping them to revocation told users with intact permissions "you lost
      // access" (#35). Doing nothing is a dead end too (`onAuthenticate`'s throw neither closes
      // the socket nor reconnects), so schedule a restart that re-fetches the token and stay at
      // `connecting`; a revoked tokenVersion then gets 401 and `onUnauthorized` logs out.
      scheduleRestart();
    });

    // Required: the 401/404 branches rethrow ⇒ `tokenFetchFailed` ⇒ `authenticationFailed` ⇒ a
    // scheduled restart would revive a terminal connection and send another collab-token request;
    // this shouldn't depend on NotePage unmounting.
    stopRestartsRef.current = () => {
      restartsStopped = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      cancelRestartFallback?.();
      cancelRestartFallback = undefined;
    };

    providerRef.current = provider;
    setSession({ doc, provider });

    return () => {
      disposed = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      cancelRestartFallback?.();
      stopRestartsRef.current = null;
      providerRef.current = null;
      disposeDocUpdate?.();
      provider.destroy();
      doc.destroy();
      setSession(null);
      setSyncedFor(null);
    };
  }, [noteId, dispatch]);

  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) return;

    if (state.phase === "reconnecting-once") {
      // The server's application-level CLOSE only sends a message, so close this socket; the
      // `"close"` listener issues the reconnect, whose token role is the second-strike criterion.
      return restartConnection(provider, pendingReconnectRef);
    }

    if (stopsReconnect(state)) {
      // `disconnect()` sets shouldConnect to false, which stops the built-in backoff.
      stopRestartsRef.current?.();
      pendingReconnectRef.current = false;
      provider.disconnect();
    }
  }, [state]);

  return { state, doc: session?.doc ?? null, provider: session?.provider ?? null, synced, syncedFor };
}
