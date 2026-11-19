import { describe, expect, it, vi, afterEach } from "vitest";
import { createCollabHooks, DELETING_GATE_TTL_MS, REVERIFY_DEADLINE_MS } from "../../src/collab/hooks-impl.js";
import type { CollabServer, ConnectionHandle } from "../../src/collab/server.js";

/**
 * The gate opened by `beforeNoteDeleted` and the `release()` handle it returns (issue #35), plus the guard on the re-verify deadline log line (issue #37).
 *
 * The integration tests call `collab.markDeleting/releaseDeletingGate` directly and `notes.test.ts` uses mocked hooks, so this file exercises the two
 * hooks-impl fixes itself: clear the old timer before re-opening the gate, and release only its own gate. Without them the symptom is only
 * collaborators occasionally seeing the wrong message.
 */
const NOTE = "11111111-1111-1111-1111-111111111111";

/** Implements only the members that `beforeNoteDeleted`/`reverify` touch. */
function fakeServer(connections: Set<ConnectionHandle> = new Set()): {
  server: CollabServer;
  calls: { mark: number[]; release: Array<[string, number]>; unmark: string[] };
} {
  const calls = { mark: [] as number[], release: [] as Array<[string, number]>, unmark: [] as string[] };
  let epoch = 0;
  const server = {
    connectionsOfNote: () => connections,
    onNextTokenSync: () => {},
    markDeleting: async (): Promise<number> => {
      epoch += 1;
      calls.mark.push(epoch);
      return epoch;
    },
    releaseDeletingGate: async (noteId: string, e: number): Promise<boolean> => {
      calls.release.push([noteId, e]);
      return true;
    },
    unmarkDeleting: (noteId: string): void => {
      calls.unmark.push(noteId);
    },
    hocuspocus: {
      flushPendingStores: () => {},
      documents: new Map(),
      unloadDocument: async () => {},
    },
  } as unknown as CollabServer;
  return { server, calls };
}

function recordingLog(): { log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void }; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    log: {
      info: (obj: object) => lines.push({ ...obj }),
      error: (obj: object) => lines.push({ ...obj }),
    },
  };
}

const silentLog = { info: () => {}, error: () => {} };

/** A fake document connection: only the members `reverify` touches. */
function fakeHandle(noteId: string, userId: string): ConnectionHandle {
  return {
    socketId: "s1",
    noteId,
    userId,
    sessionId: undefined,
    presenceRole: "editor",
    requestToken: () => {},
    close: () => {},
    setReadOnly: () => {},
  };
}

/**
 * The re-verify deadline log line (issue #37).
 *
 * The timer firing on an already-closed connection is a deliberate idempotent no-op, so a user closing the tab themselves lands here too.
 * Logging it would make the line the docs troubleshooting guide relies on most ("if they insist they still have access, this line says they don't")
 * point at someone who was never kicked. The guard is "is this connection still in the index", and it needs its own test so that
 * removing it is detected (this family has hit the same shape before).
 */
describe("re-verify deadline log", () => {
  const USER = "22222222-2222-2222-2222-222222222222";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connection still in the index (client just didn't answer) -> logs one deadline line", async () => {
    vi.useFakeTimers();
    const handle = fakeHandle(NOTE, USER);
    const { server } = fakeServer(new Set([handle]));
    const { log, lines } = recordingLog();

    createCollabHooks(server, log).onShareChanged(NOTE, USER);
    await vi.advanceTimersByTimeAsync(REVERIFY_DEADLINE_MS + 100);

    const line = lines.find(one => one.phase === "deadline");
    expect(line).toMatchObject({ cause: "no-reverify", noteId: NOTE, userId: USER });
  });

  it("connection no longer in the index (user closed the tab) -> logs nothing", async () => {
    vi.useFakeTimers();
    const handle = fakeHandle(NOTE, USER);
    const live = new Set([handle]);
    const { server } = fakeServer(live);
    const { log, lines } = recordingLog();

    createCollabHooks(server, log).onShareChanged(NOTE, USER);
    // Tab closed before the deadline: the server's `connection.onClose` removes the handle from the index synchronously.
    live.delete(handle);
    await vi.advanceTimersByTimeAsync(REVERIFY_DEADLINE_MS + 100);

    // The title says nothing is logged, so assert the whole output: filtering only deadline lines would let an error line from the
    // catch branch through and make the claim half true.
    expect(lines).toEqual([]);
  });
});

describe("beforeNoteDeleted gate handle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-opening the gate clears the previous TTL timer (otherwise the first timer opens the second gate early)", async () => {
    vi.useFakeTimers();
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    await hooks.beforeNoteDeleted(NOTE);
    await hooks.beforeNoteDeleted(NOTE);

    await vi.advanceTimersByTimeAsync(DELETING_GATE_TTL_MS + 1_000);
    // If the old timer weren't cleared this would be 2: the first would open the second gate while it should still be closed.
    expect(calls.unmark).toEqual([NOTE]);
  });

  it("release() takes the generation number of its own gate, not the current latest one", async () => {
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    const first = await hooks.beforeNoteDeleted(NOTE);
    await hooks.beforeNoteDeleted(NOTE);
    expect(calls.mark).toEqual([1, 2]);

    first.release();
    await vi.waitFor(() => expect(calls.release).toHaveLength(1));
    // It carries 1 (its own gate), not 2: otherwise when a concurrent second delete succeeds, the first one's failure would close its
    // gate, and collaborators reconnecting over the next two minutes would be told "you lost access".
    expect(calls.release[0]).toEqual([NOTE, 1]);
  });
});

/** #181: release the deleting gate after the restore commit. */
describe("onNotesRestored", () => {
  const OTHER = "33333333-3333-3333-3333-333333333333";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the gate and clears the TTL timer (no second unmark at expiry)", async () => {
    vi.useFakeTimers();
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    await hooks.beforeNoteDeleted(NOTE);
    hooks.onNotesRestored([NOTE]);
    expect(calls.unmark).toEqual([NOTE]);

    await vi.advanceTimersByTimeAsync(DELETING_GATE_TTL_MS + 1);
    expect(calls.unmark).toEqual([NOTE]);
  });

  it("the same note repeated is unmarked only once; an id with no gate is still called, without throwing", async () => {
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    await hooks.beforeNoteDeleted(NOTE);
    expect(() => hooks.onNotesRestored([NOTE, NOTE, OTHER])).not.toThrow();
    expect(calls.unmark).toEqual([NOTE, OTHER]);
  });

  it("unmarkDeleting throws -> does not rethrow, logs one error (only name/code/count)", () => {
    const { server } = fakeServer();
    server.unmarkDeleting = () => {
      throw Object.assign(new Error("boom"), { cause: { code: "E_TEST" } });
    };
    const log = { info: vi.fn(), error: vi.fn() };
    const hooks = createCollabHooks(server, log);

    expect(() => hooks.onNotesRestored([NOTE])).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toEqual({ name: "Error", code: "E_TEST", notes: 1 });
  });
});
