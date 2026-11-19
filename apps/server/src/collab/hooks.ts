/**
 * `release()` it if the delete transaction fails, or new connections are told the note was deleted
 * for the gate's two-minute TTL. Users already closed by `beforeNoteDeleted` stay kicked (see
 * docs/known-limitations.md). Fire-and-forget, releases only this delete's gate, and must not throw:
 * callers are handling another error.
 */
export interface NoteDeleteGate {
  release(): void;
}

export interface CollabHooks {
  // The void hooks run after the DB commit: they must not throw, or a committed request returns 500.
  onShareChanged(noteId: string, userId: string): void;
  onUserRevoked(userId: string): void;
  /** #388: only connections whose token came from this session; the user's other devices are untouched. */
  onSessionRevoked(userId: string, sessionId: string): void;
  /** #103: call after commit, for upgrades too (re-verifying lifts read-only). */
  onGroupAccessChanged(noteIds: readonly string[], userIds: readonly string[]): void;
  /** Await before the delete transaction; `release()` the returned gate if the transaction fails. */
  beforeNoteDeleted(noteId: string): Promise<NoteDeleteGate>;
  /**
   * #181: closes the gates without checking epochs, so callers must pass only ids the restore actually
   * restored, and call it synchronously after commit with no await in between; otherwise a delete
   * starting in that window loses its gate and users reconnecting during its unload poll keep writing
   * to the trashed note. Accepted gap: a concurrent DELETE still in its unload poll (≤5 s) loses its gate.
   */
  onNotesRestored(noteIds: readonly string[]): void;
  /** `ok: false`: doc not loaded or user not connected to it; callers answer 409 `not_loaded`, deliberately with no `note_states` fallback. */
  linkSyncGate(noteId: string, userId: string): { ok: true; clock: number } | { ok: false };
}

export const noopCollabHooks: CollabHooks = {
  onShareChanged: () => {},
  onUserRevoked: () => {},
  onSessionRevoked: () => {},
  onGroupAccessChanged: () => {},
  beforeNoteDeleted: async () => ({ release: () => {} }),
  onNotesRestored: () => {},
  linkSyncGate: () => ({ ok: false }),
};
