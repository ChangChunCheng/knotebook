// Revocation is "re-verify + deadline": affected connections get requestToken(), and any that don't
// answer before the deadline are closed (fail-closed).
// No hook throws: the sync ones run after the DB commit, where a throw turns a committed request into
// a 500; beforeNoteDeleted runs before the delete transaction, where a throw would leave the note
// undeletable yet gated for DELETING_GATE_TTL_MS.
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, COLLAB_REVERIFY_DEADLINE_MS } from "@knotebook/shared";
import type { CollabHooks, NoteDeleteGate } from "./hooks.js";
import type { CollabServer, ConnectionHandle } from "./server.js";

/** Re-exported for existing tests; the rationale is on `COLLAB_REVERIFY_DEADLINE_MS`. */
export const REVERIFY_DEADLINE_MS = COLLAB_REVERIFY_DEADLINE_MS;

// Without the gate, a reconnect after the delete commits is refused as no-role, telling the user they
// lost access (#35). The gate only holds notes this process just deleted, so unlike a DB lookup it is
// no existence oracle. The TTL must outlast the client's longest restart backoff (60 s + 25% jitter =
// 75 s, apps/web/src/collab/useCollab.ts). A failed delete calls `release()` instead of waiting.
export const DELETING_GATE_TTL_MS = 120_000;

/** Unload poll: at most 20 × 250 ms = 5 s. */
const UNLOAD_POLL_INTERVAL_MS = 250;
const UNLOAD_POLL_ATTEMPTS = 20;

/** Structural, not pino's type: hooks are created before `buildApp()`, when no `app.log` exists yet. */
export interface CollabHooksLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

// Not a silent no-op: these errors mean revocation or delete cleanup failed, which must stay visible.
const consoleLogger: CollabHooksLogger = {
  info: (obj, msg) => console.info(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCollabHooks(server: CollabServer, log: CollabHooksLogger = consoleLogger): CollabHooks {
  // Re-arming must clear the old timer, or a retried delete's gate would open when the first TTL
  // ends; the epoch keeps release() from clearing another delete's timer.
  const gateTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number }>();
  // Pass a snapshot: connectionsOf* return live index sets that a synchronous close mutates mid-loop.
  // No onDisconnect cleanup of deadline timers: firing on a closed connection is a no-op (v4.5.0
  // Connection.close guards with document.hasConnection), far simpler than tracking pending timers.
  function reverify(conns: Iterable<ConnectionHandle>): void {
    for (const c of conns) {
      // Arm the deadline before anything that can throw: an exception must never leave a connection
      // neither re-verified nor closed (fail-open).
      const t = setTimeout(() => {
        // Timer callbacks have no caller: an escaping exception would crash the process.
        try {
          // #37: the likeliest path for wrongly kicking a legitimate user, so log it, but only while the
          // connection is still indexed: a tab the user closed also ends up here.
          const stillConnected = server.connectionsOfNote(c.noteId).has(c);
          if (stillConnected) {
            log.info(
              { phase: "deadline", noteId: c.noteId, userId: c.userId, cause: "no-reverify", reason: COLLAB_CLOSE_REVOKED },
              "collab 重驗逾時關閉連線"
            );
          }
          c.close(COLLAB_CLOSE_REVOKED);
        } catch (error) {
          log.error({ err: error, noteId: c.noteId, userId: c.userId }, "collab 重驗 deadline 關閉連線失敗");
        }
      }, REVERIFY_DEADLINE_MS);

      // Per connection, so one failure can't skip re-verifying the rest (v4.5.0 send already swallows
      // send errors; this doesn't rely on it).
      try {
        // Registered during an in-flight onTokenSync (callbacks already taken), this won't fire if that
        // sync closes the connection; the timer then fires on a closed connection, a no-op.
        server.onNextTokenSync(c, () => clearTimeout(t));
        c.requestToken(); // fire-and-forget, no built-in timeout
      } catch (error) {
        log.error({ err: error, noteId: c.noteId, userId: c.userId }, "collab 重驗單一連線失敗，立即關閉該連線");
        // Fail closed now; the timer stays armed in case this close throws too.
        try {
          c.close(COLLAB_CLOSE_REVOKED);
        } catch (closeError) {
          log.error(
            { err: closeError, noteId: c.noteId, userId: c.userId },
            "collab 重驗失敗後關閉連線亦失敗（deadline timer 仍為保險）"
          );
        }
      }
    }
  }

  return {
    /** Only this user's connections: re-verifying everyone spikes the token endpoint, hits per-user throttling, and can drop a legitimate connection that answers late. */
    onShareChanged(noteId: string, userId: string): void {
      try {
        reverify([...server.connectionsOfNote(noteId)].filter(c => c.userId === userId));
      } catch (error) {
        log.error({ err: error, noteId, userId }, "collab onShareChanged 重驗失敗");
      }
    },

    onUserRevoked(userId: string): void {
      try {
        reverify([...server.connectionsOf(userId)]);
      } catch (error) {
        log.error({ err: error, userId }, "collab onUserRevoked 重驗失敗");
      }
    },

    onSessionRevoked(userId: string, sessionId: string): void {
      try {
        reverify([...server.connectionsOf(userId)].filter(c => c.sessionId === sessionId));
      } catch (error) {
        log.error({ err: error, userId }, "collab onSessionRevoked 重驗失敗");
      }
    },

    /** #103: logs counts only, since the lists grow with group size. */
    onGroupAccessChanged(noteIds: readonly string[], userIds: readonly string[]): void {
      try {
        const targets = new Set(userIds);
        const conns: ConnectionHandle[] = [];
        for (const noteId of new Set(noteIds)) {
          for (const c of server.connectionsOfNote(noteId)) if (targets.has(c.userId)) conns.push(c);
        }
        reverify(conns);
      } catch (error) {
        log.error({ err: error, notes: noteIds.length, users: userIds.length }, "collab onGroupAccessChanged 重驗失敗");
      }
    },

    // Not closeConnections(): v4 closes with ResetConnection, so providers reconnect at once, re-auth
    // (the note still exists before commit), reload the doc, and the poll never settles. Late updates
    // can still slip in; onStoreDocument drops stores for missing notes, and one into a trashed note (#181) doesn't un-trash it.
    async beforeNoteDeleted(noteId: string): Promise<NoteDeleteGate> {
      // Close the gate first so no new connection joins during the cleanup.
      const epoch = await server.markDeleting(noteId);

      const previous = gateTimers.get(noteId);
      if (previous !== undefined) clearTimeout(previous.timer);

      // unref(): the gate only matters while serving; don't keep the process (or a test worker) alive for it.
      const ttl = setTimeout(() => {
        gateTimers.delete(noteId);
        server.unmarkDeleting(noteId);
      }, DELETING_GATE_TTL_MS);
      ttl.unref();
      gateTimers.set(noteId, { timer: ttl, epoch });

      const gate: NoteDeleteGate = {
        release: () => {
          void server
            .releaseDeletingGate(noteId, epoch)
            .then(released => {
              if (!released) return;
              const armed = gateTimers.get(noteId);
              // A newer delete may have taken over while release was pending.
              if (armed?.epoch !== epoch) return;
              clearTimeout(armed.timer);
              gateTimers.delete(noteId);
            })
            .catch((error: unknown) => {
              log.error({ err: error, noteId }, "collab 刪除失敗後收閘門亦失敗（閘門將由 TTL 自然到期）");
            });
        },
      };

      try {
        // Snapshot: close() synchronously removes the connection from the index.
        for (const c of [...server.connectionsOfNote(noteId)]) c.close(COLLAB_CLOSE_NOTE_DELETED);

        // Returns void, so whether the stores landed is observed through the unload poll.
        server.hocuspocus.flushPendingStores();

        const doc = server.hocuspocus.documents.get(noteId);
        // unloadDocument silently no-ops while a store is in flight, hence the poll; .catch keeps a
        // throwing unload hook from becoming an unhandled rejection.
        if (doc) void server.hocuspocus.unloadDocument(doc).catch(() => {});

        for (let i = 0; i < UNLOAD_POLL_ATTEMPTS && server.hocuspocus.documents.has(noteId); i += 1) {
          await sleep(UNLOAD_POLL_INTERVAL_MS);
          const d = server.hocuspocus.documents.get(noteId);
          if (d) void server.hocuspocus.unloadDocument(d).catch(() => {});
        }

        if (server.hocuspocus.documents.has(noteId)) {
          // Proceed anyway: a hung DELETE is worse. Late stores land in the trashed note, or are dropped once purged.
          log.error({ noteId }, "collab beforeNoteDeleted：文件在期限內未 unload，仍繼續刪除（之後的 store：移入垃圾桶照寫、永久刪除丟棄）");
        }
      } catch (error) {
        // Must not 500 the DELETE: the gate is closed, and leftover connections are refused at their next re-verify.
        log.error({ err: error, noteId }, "collab beforeNoteDeleted 清場失敗，仍繼續刪除");
      }

      return gate;
    },

    onNotesRestored(noteIds: readonly string[]): void {
      try {
        for (const id of new Set(noteIds)) {
          const armed = gateTimers.get(id);
          if (armed) {
            clearTimeout(armed.timer);
            gateTimers.delete(id);
          }
          server.unmarkDeleting(id);
        }
      } catch (error) {
        const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
        log.error({ name: e?.name, code: e?.code ?? e?.cause?.code, notes: noteIds.length }, "collab onNotesRestored 收閘門失敗");
      }
    },

    linkSyncGate(noteId: string, userId: string): { ok: true; clock: number } | { ok: false } {
      return server.linkSyncState(noteId, userId);
    },
  };
}
