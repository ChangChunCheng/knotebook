import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { ApiFail } from "@/api/client";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_CLIENT_OUTDATED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
  COLLAB_REVERIFY_DEADLINE_MS,
  COLLAB_TOKEN_RETRY_DELAYS_MS,
  NOTE_SCHEMA_VERSION,
} from "@knotebook/shared";

// HocuspocusProvider opens a real WebSocket and jsdom has no peer. Replace it with a fake that stores the
// configuration so tests can act as the server (trigger onClose/onAuthenticated) and records
// disconnect/connect/destroy calls.
interface FakeProvider {
  configuration: Record<string, unknown> & {
    token: () => Promise<string>;
    onAuthenticated: () => void;
  };
  listeners: Map<string, ((payload: unknown) => void)[]>;
  emit: (event: string, payload: unknown) => void;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  synced: boolean;
}

const hoisted = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    configuration: unknown;
    listeners = new Map<string, ((payload: unknown) => void)[]>();
    disconnect = vi.fn();
    connect = vi.fn();
    destroy = vi.fn();
    awareness = {};
    synced = false;
    constructor(configuration: unknown) {
      this.configuration = configuration;
      hoisted.instances.push(this);
    }
    on(event: string, handler: (payload: unknown) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, payload: unknown) {
      for (const handler of this.listeners.get(event) ?? []) handler(payload);
    }
  },
}));

const { useCollab } = await import("./useCollab");

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_NOTE_ID = "22222222-2222-2222-2222-222222222222";

function provider(index = 0): FakeProvider {
  return hoisted.instances[index] as FakeProvider;
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const tokenOk = (role: string) =>
  fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: "jwt", role }) });

const apiFail = (status: number, code: string) =>
  fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });

function Probe({ onUnauthorized, noteId = NOTE_ID }: { onUnauthorized?: () => void; noteId?: string }) {
  const { state } = useCollab({ noteId, onUnauthorized: onUnauthorized ?? (() => {}) });
  return <div data-testid="phase">{state.phase === "connected" ? `connected:${state.role}` : state.phase}</div>;
}

const phase = () => screen.getByTestId("phase").textContent;

function SyncProbe({ noteId = NOTE_ID }: { noteId?: string }) {
  const { synced } = useCollab({ noteId, onUnauthorized: () => {} });
  return <div data-testid="synced">{String(synced)}</div>;
}
const syncedText = () => screen.getByTestId("synced").textContent;

function SyncedForProbe({ noteId }: { noteId: string | undefined }) {
  const { syncedFor } = useCollab({ noteId, onUnauthorized: () => {} });
  return <div data-testid="synced-for">{syncedFor ?? "null"}</div>;
}
const syncedForText = () => screen.getByTestId("synced-for").textContent;

/** Exposes the `doc` returned by `useCollab` so tests can mutate it (#138 doc-update notification). */
const docRef: { current: Y.Doc | null } = { current: null };
function DocUpdateProbe({ onDocUpdate }: { onDocUpdate: () => void }) {
  const { doc } = useCollab({ noteId: NOTE_ID, onUnauthorized: () => {}, onDocUpdate });
  docRef.current = doc;
  return null;
}

describe("useCollab", () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("provider owns its socket: no websocketProvider is passed and sessionAwareness is off", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<Probe />);

    const config = provider().configuration;
    expect(config.name).toBe(NOTE_ID);
    expect(String(config.url)).toMatch(/^wss?:\/\/.+\/collab$/);
    // A shared websocketProvider would make disconnect() a no-op, breaking the whole revoke flow.
    expect(config).not.toHaveProperty("websocketProvider");
    // sessionAwareness would turn documentName into a composite key, colliding with the server's connection index.
    expect(config.sessionAwareness).toBeUndefined();
  });

  it("close listener goes through provider.on('close'), not the configuration (it would be registered twice there)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<Probe />);

    // When the provider owns its socket it hands the same configuration to the inner HocuspocusProviderWebsocket,
    // so configuration.onClose would be attached twice and fire twice per socket close; the one-shot pending flag
    // would be consumed by the second call.
    expect(provider().configuration).not.toHaveProperty("onClose");
    expect(provider().listeners.get("close")).toHaveLength(1);
  });

  it("when disconnect() yields no close event, the timeout fuse still triggers one reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(p.connect).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("reconnecting-once");
  });

  it("token function calls the collab-token endpoint and drives state from the top-level role in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);

    const config = provider().configuration;
    await act(async () => {
      await expect(config.token()).resolves.toBe("jwt");
    });

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/notes/${NOTE_ID}/collab-token`);
    expect(init.method).toBe("POST");
    // #269: the token request carries the note schema version (the client-outdated gate).
    expect(JSON.parse(String(init.body))).toEqual({ noteSchemaVersion: NOTE_SCHEMA_VERSION });

    expect(phase()).toBe("connecting");
    act(() => config.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("token 401 -> sign-out callback, no retry", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(401, "unauthorized")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe onUnauthorized={onUnauthorized} />);

    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("token 429 -> back off and retry (not an authorization failure, must not kick)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiFail(429, "too_many_requests"))
      .mockResolvedValueOnce(apiFail(503, "server_busy"))
      .mockResolvedValue(tokenOk("viewer"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);

    const pending = provider().configuration.token();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await expect(pending).resolves.toBe("jwt");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(phase()).toBe("connecting");
  });

  it("double-strike revoke: close(REVOKED) -> disconnect+connect -> token role 'none' -> kicked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);

    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    // First strike: only disconnect; must not connect yet (the socket is not really closed, and
    // HocuspocusProviderWebsocket.connect() is a no-op while its status is still Connected).
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    expect(p.connect).not.toHaveBeenCalled();

    // The socket close caused by our own disconnect() (empty reason) must be swallowed, otherwise the observation
    // window resets to connecting and the second strike never arrives; the reconnect fires at exactly this moment.
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.connect).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("a second close(REVOKED) also reaches kicked (the path where the server really sends another application-level CLOSE)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("kicked");
  });

  it("network drop (other reasons) -> connecting, no disconnect call (left to the provider's built-in backoff)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:owner");

    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("downgrade: a token returning viewer while connected -> stays connected but the role changes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    fetchMock.mockResolvedValue(tokenOk("viewer"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("connected:viewer");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("close(NOTE_DELETED) -> deleted terminal state, reconnecting stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_NOTE_DELETED } }));
    expect(phase()).toBe("deleted");
    await waitFor(() => expect(p.disconnect).toHaveBeenCalled());
  });

  it("token endpoint 404 -> deleted (fuse for a note that no longer exists at reconnect time)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(404, "not_found"))),
    );
    render(<Probe />);

    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });
    expect(phase()).toBe("deleted");
  });

  // issue #6: authenticationFailed (the server's permission-denied Auth message).
  //
  // Shared premise: for an error thrown from `onAuthenticate`, the Hocuspocus server sends back only one
  // permission-denied message and leaves the socket as it is (Hocuspocus 4.5.0 `ClientConnection`); the provider
  // does not reconnect on its own. Without handling this event the UI stays on connecting forever.

  it("revoked before the handshake completes: authenticationFailed -> reconnect once -> role 'none' -> kicked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    // Not yet onAuthenticated: the server rejected at handshake time, so the client never receives CLOSE(REVOKED).
    expect(phase()).toBe("connecting");

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    expect(p.connect).not.toHaveBeenCalled();

    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
  });

  it("authenticationFailed again during reconnecting-once -> kicked (second strike)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("kicked");
  });

  it("authenticationFailed(note-deleting) -> deleted terminal state (no second strike)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_NOTE_DELETING }));
    expect(phase()).toBe("deleted");
    await waitFor(() => expect(p.disconnect).toHaveBeenCalled());
  });

  it("authenticationFailed caused by the token function's own failure is not an authorization verdict and must not kick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;

    // The provider calls permissionDeniedHandler directly in the getToken() catch (see `sendToken` in dist): the
    // reason is a local string, not a server verdict; 5xx/network failures must not kick.
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("switching notes: a late token failure from the previous connection must not swallow the new connection's authorization rejection", async () => {
    // After the old provider is destroyed, its still in-flight token request can still fail back (the backoff loop's
    // `disposed` guard only stops retries; it cannot recall the request already sent). If the "last token fetch
    // failed" flag lived at hook level (`useRef`) rather than per connection, that failure would set it back to true,
    // and the old provider's `authenticationFailed` never clears it (`destroy()` ran `removeAllListeners()`). When the
    // new note is then really revoked before the handshake, that rejection would be silently swallowed, bringing
    // issue #6 back unchanged.
    //
    // Must be the same component instance with a changed noteId (rerender): unmount + `render()` makes two component
    // instances with separate refs, so the leak could never occur.
    let failStale!: (err: unknown) => void;
    const staleFetch = new Promise<Response>((_resolve, reject) => {
      failStale = reject;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = expect(stale.configuration.token()).rejects.toThrow();

    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });

    await act(async () => {
      failStale(new Error("network went away"));
      await staleToken;
    });

    act(() => fresh.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("reconnecting-once");
  });

  it("authenticationFailed(invalid-token) is not an authorization verdict: no kick, schedule one restart instead (issue #35)", async () => {
    // An unverifiable token, a session whose tokenVersion was revoked (account disabled / password changed elsewhere)
    // and a server-side DB blip all land in this bucket. Treating any of them as a revoke would tell a user
    // with intact access that they lost it and navigate them away.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();

    // But it can't just be left there: the socket is open yet unauthenticated, and the provider will not fetch a token
    // again (the silent dead end of issues #34/#39). After the first 5s slot the whole connection restarts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("authenticationFailed(server-error / unrecognized reason) also must not kick", async () => {
    // An unexpected server-side exception is translated by Hocuspocus to the literal "permission-denied" (we changed it
    // to an explicit server-error, but an old server or a future new reason can produce unrecognized values); all of
    // them count as "not a verdict".
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_SERVER_ERROR }));
    expect(phase()).toBe("connecting");
    act(() => p.emit("authenticationFailed", { reason: "permission-denied" }));
    expect(phase()).toBe("connecting");
    // A missing reason is the same (the classic `reason === undefined` misjudgment).
    act(() => p.emit("authenticationFailed", {}));
    expect(phase()).toBe("connecting");
  });

  it("invalid-token during reconnecting-once: not a second strike and does not break convergence (issue #35)", async () => {
    // A non-verdict rejection arrives inside the revoke observation window: state must not advance to kicked, and the
    // scheduled restart must not clash with the one from the state effect itself (double disconnect / swallowing the pending flag).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("reconnecting-once");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
  });

  it("connecting cancels a pending restart (otherwise that timer would tear down a healthy connection and redo it)", async () => {
    // A rejection scheduled a restart in 5s at t=0, but the server recovered quickly and the provider's built-in
    // backoff connected first. Leaving that timer would disconnect a healthy connection at t=5s and spend one more
    // collab-token quota (per user, shared across tabs).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("connecting");

    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).not.toHaveBeenCalled();
    expect(phase()).toBe("connected:editor");
  });

  it("terminal state cancels the restart scheduled by a rejection, not only the one from a token failure", async () => {
    // Rejections also feed the stopRestartsRef gate; without this case, a refactor could let a
    // timer revive a terminal-state connection.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_SERVER_ERROR }));
    expect(phase()).toBe("connecting");

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_NOTE_DELETED } }));
    expect(phase()).toBe("deleted");
    const disconnectsAtTerminal = p.disconnect.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // Must not reconnect again: that would be a zombie connection with nobody handling its events.
    expect(p.disconnect).toHaveBeenCalledTimes(disconnectsAtTerminal);
    expect(p.connect).not.toHaveBeenCalled();
    expect(phase()).toBe("deleted");
  });

  it("rejection-driven restarts also widen each time (backoff slots shared with token failure)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));

    // Second rejection: must not come again after 5s (the server is still unhealthy, second-level retries only add
    // load, and the collab-token quota is shared across tabs).
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("switching notes: a late 404 from the previous note must not turn the new note into deleted (the other half of issue #36)", async () => {
    // The success exit and the 404 exit are the same leak: both dispatch into the hook-level state machine. The 404 path
    // dispatches the terminal state deleted, which is harder to recover than a wrong role (the user is navigated away
    // from a note that still exists).
    let failStale!: (err: unknown) => void;
    const staleFetch = new Promise<Response>((_resolve, reject) => {
      failStale = reject;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = expect(stale.configuration.token()).rejects.toThrow();

    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    await act(async () => {
      failStale(new ApiFail(404, "not_found", "gone"));
      await staleToken;
    });
    expect(phase()).toBe("connected:editor");
  });

  it("switching notes: a late token success from the previous note must not feed into the new note's state machine (issue #36)", async () => {
    // `roleRef` and `dispatch` live at hook level (not rebuilt per effect); without the `disposed` guard on the success
    // exit, the previous note's in-flight response would hit the new note: if the new note is in reconnecting-once
    // (revoke observation window) and the late role is the previous note's 'none', it is judged a second strike and
    // the user is kicked from a note they have access to.
    //
    // Must be the same component instance with a changed noteId (rerender): unmount + render makes two component
    // instances with separate refs, so the leak could never occur.
    let resolveStale!: (res: Response) => void;
    const staleFetch = new Promise<Response>(resolve => {
      resolveStale = resolve;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = stale.configuration.token();

    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    act(() => fresh.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");

    await act(async () => {
      resolveStale(tokenOk("none"));
      await staleToken;
    });
    expect(phase()).toBe("reconnecting-once");

    // roleRef must not be overwritten by the stale value either, otherwise the following open carries the wrong role.
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("issue #48: synced starts false and becomes true after the provider syncs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<SyncProbe />);
    const p = provider();
    expect(syncedText()).toBe("false");

    p.synced = true;
    act(() => p.emit("synced", { state: true }));
    await waitFor(() => expect(syncedText()).toBe("true"));
  });

  it("issue #48: synced is sticky - it does not reset on disconnect after syncing (offline edits have something to merge back into)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<SyncProbe />);
    const p = provider();
    p.synced = true;
    act(() => p.emit("synced", { state: true }));
    await waitFor(() => expect(syncedText()).toBe("true"));

    p.synced = false;
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(syncedText()).toBe("true");
  });

  it("issue #48: switching notes resets synced (the new connection's Y.Doc is empty and not loaded yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    const { rerender } = render(<SyncProbe noteId={NOTE_ID} />);
    const p = provider(0);
    p.synced = true;
    act(() => p.emit("synced", { state: true }));
    await waitFor(() => expect(syncedText()).toBe("true"));

    rerender(<SyncProbe noteId={OTHER_NOTE_ID} />);
    expect(syncedText()).toBe("false");
  });

  // #138: doc update -> debounce -> `onDocUpdate` (NotePage uses it to invalidate the note query). The debouncer is
  // attached in the `"synced"` handler, not the effect body: the initial-sync batch of updates also has the provider
  // as origin, and attaching in the body would invalidate the note query once for nothing on page open.
  it("remote and local updates after sync notify; the first-sync batch does not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    const onDocUpdate = vi.fn();
    render(<DocUpdateProbe onDocUpdate={onDocUpdate} />);
    const p = provider(0);
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    const doc = docRef.current!;
    const text = doc.getText("t");

    act(() => {
      doc.transact(() => text.insert(0, "sync"), p);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onDocUpdate).not.toHaveBeenCalled();

    p.synced = true;
    act(() => p.emit("synced", { state: true }));
    act(() => {
      doc.transact(() => text.insert(0, "x"), p);
      doc.transact(() => text.insert(0, "y"), p);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onDocUpdate).toHaveBeenCalledTimes(1);

    // A local origin (own typing) notifies too: the server writes `last_edited_*` for own edits the same way;
    // without a notification the header's "last edited" only updates after a reload.
    act(() => {
      doc.transact(() => text.insert(0, "z"), { local: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onDocUpdate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("rejection reason constants match the server-side literals", () => {
    // If the shared package was not rebuilt these constants are undefined, so `reason === CONST` silently takes the
    // wrong branch. Pinning the literals makes such an environment fail loudly instead of passing falsely.
    expect(COLLAB_REJECT_NOTE_DELETING).toBe("note-deleting");
    expect(COLLAB_REJECT_INVALID_TOKEN).toBe("invalid-token");
    expect(COLLAB_REJECT_FORBIDDEN).toBe("forbidden");
    expect(COLLAB_REJECT_SERVER_ERROR).toBe("server-error");
  });

  it("a close that arrives after the fuse fired still brings out that reconnect (issue #34)", async () => {
    // `HocuspocusProviderWebsocket.connect()` starts with `if (status === Connected) return`, and that early return
    // happens before `shouldConnect = true`. So if the socket is not really closed when the fuse fires, that connect()
    // is a no-op; if the fuse also cleared the pending flag, the close that arrives later would be treated as a normal
    // drop and sent back to `connecting`, and the provider's built-in backoff would not start either because
    // `shouldConnect === false` => socket closed, nobody reconnects, stuck on "connecting" forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    // The real close arrives only now: it must still bring out the reconnect, not reset the state to connecting.
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.connect).toHaveBeenCalledTimes(2);
  });

  it("after all token retries are used up, the connection restarts itself once instead of hanging silently (issue #39)", async () => {
    // Backoff table exhausted -> `fetchToken` throws -> the provider calls `permissionDeniedHandler` directly in the
    // `getToken()` catch, and the socket neither closes nor fetches a token again. We deliberately do not treat this
    // `authenticationFailed` as revocation, so the state machine receives no event; without this self-healing the UI
    // stays on "connecting" forever, even after the server recovers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The restart interval has +-25% jitter (so tabs don't retry in phase). Pinning the random value at the midpoint
    // makes the delay equal the nominal one, so the test isn't gambling on timing.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(503, "server_busy")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    expect(phase()).toBe("connecting");
    expect(p.connect).not.toHaveBeenCalled();

    // But it must restart itself: after the restart delay (first slot 5s) the whole handshake reruns (disconnect ->
    // close -> connect). The test stops at 5.5s on purpose: 0.5s more would also fire the fuse (1s after the restart),
    // and the reconnect brought out by close could no longer be told from the one the fuse supplies.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("after a restart the token finally succeeds -> really connected (self-healing converges, not just 'tried again')", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(503, "server_busy")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    fetchMock.mockResolvedValue(tokenOk("editor"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));

    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("restart backoff widens each time (the second does not come again after 5s)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    render(<Probe />);
    const p = provider();

    const failOnce = async () => {
      const rejected = expect(p.configuration.token()).rejects.toThrow();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await rejected;
      act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));
    };

    await failOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    await failOnce();
    // The second slot is 15s: at 6s it must not have come yet (if the backoff table were hardcoded to one value this would fail).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("unmount takes the scheduled restart with it (otherwise a zombie connection nobody handles remains)", async () => {
    // After `provider.destroy()` all of that provider's event listeners are removed and its connection-check interval is
    // stopped. A leaked timer calling `connect()` would open a new WebSocket nobody handles events for, leaking one per
    // note switch. This test guards the order in cleanup (clear the timer first, then destroy).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    const { unmount } = render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(p.connect).not.toHaveBeenCalled();
  });

  it("unmount destroys the provider", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { unmount } = render(<Probe />);
    const p = provider();
    unmount();
    expect(p.destroy).toHaveBeenCalledTimes(1);
  });

  it("#269: authenticationFailed(client-outdated) -> outdated, disconnect(), no restart scheduled (still no connect after 60s)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(tokenOk("editor"))));
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_CLIENT_OUTDATED }));
    expect(phase()).toBe("outdated");
    expect(p.disconnect).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(p.connect).not.toHaveBeenCalled();
    expect(phase()).toBe("outdated");
  });

  it("#269 syncedFor: after synced = that note's id; switching notes (including through undefined) gives null; a late synced from an old provider must not set the old id back", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { rerender } = render(<SyncedForProbe noteId={NOTE_ID} />);
    expect(syncedForText()).toBe("null");
    act(() => provider(0).emit("synced", { state: true }));
    expect(syncedForText()).toBe(NOTE_ID);
    rerender(<SyncedForProbe noteId={undefined} />);
    expect(syncedForText()).toBe("null");
    rerender(<SyncedForProbe noteId={OTHER_NOTE_ID} />);
    expect(syncedForText()).toBe("null");
    act(() => provider(0).emit("synced", { state: true })); // old provider is late (the fake provider's destroy does not clear listeners)
    expect(syncedForText()).toBe("null");
    act(() => provider(1).emit("synced", { state: true }));
    expect(syncedForText()).toBe(OTHER_NOTE_ID);
  });
});

/**
 * Issue #40: the revoke re-verify deadline and the token retry table are a cross-side coupled trade-off. The
 * deadline (5s) is deliberately shorter than the sum of the retry table (7.5s), as the last fail-closed safety
 * net for revocation (loosening the deadline would eat the margin of "revoked access <= 10s"; the real cost of a
 * wrongful kick and the invariant are in the COLLAB_REVERIFY_DEADLINE_MS comment in shared, not repeated here).
 *
 * This pins that relationship: changing either number so the relationship flips (deadline >= retry sum) fails
 * the test, forcing whoever tunes it to face the trade-off again: not "don't tune", but "don't tune unknowingly".
 */
describe("revoke re-verify deadline vs token retry table (issue #40)", () => {
  it("the deadline is deliberately shorter than the client's worst-case retry sum (fail-closed)", () => {
    const worstCaseRetryMs = COLLAB_TOKEN_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    expect(COLLAB_REVERIFY_DEADLINE_MS).toBeLessThan(worstCaseRetryMs);
  });
});
