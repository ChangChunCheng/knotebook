import { describe, expect, it } from "vitest";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, type Role } from "@knotebook/shared";
import { COLLAB_CLOSE_CLIENT_OUTDATED, collabReducer, INITIAL_COLLAB_STATE, isTerminal, stopsReconnect, type CollabEvent, type CollabState } from "./connection";

const open = (role: Role): CollabEvent => ({ type: "open", role });
const close = (reason: string): CollabEvent => ({ type: "close", reason });
const tokenRole = (role: Role): CollabEvent => ({ type: "token-role", role });

/** close reason for a network-level disconnect: the browser's native CloseEvent reason is almost always an empty string. */
const NETWORK_CLOSE = "";
/** reason broadcast by Hocuspocus `closeConnections()` (not a revocation, so an "other reason"). */
const RESET_CONNECTION = "Reset Connection";

const CONNECTING: CollabState = { phase: "connecting" };
const RECONNECTING_ONCE: CollabState = { phase: "reconnecting-once" };
const KICKED: CollabState = { phase: "kicked" };
const DELETED: CollabState = { phase: "deleted" };
const connected = (role: Role): CollabState => ({ phase: "connected", role });

const ALL_EVENTS: CollabEvent[] = [
  open("owner"),
  open("editor"),
  open("viewer"),
  open("none"),
  close(COLLAB_CLOSE_REVOKED),
  close(COLLAB_CLOSE_NOTE_DELETED),
  close(NETWORK_CLOSE),
  close(RESET_CONNECTION),
  tokenRole("owner"),
  tokenRole("editor"),
  tokenRole("viewer"),
  tokenRole("none"),
];

describe("INITIAL_COLLAB_STATE", () => {
  it("starts in connecting", () => {
    expect(INITIAL_COLLAB_STATE).toEqual({ phase: "connecting" });
  });
});

describe("collabReducer - open", () => {
  it("connecting + open -> connected with the role from the token response body", () => {
    expect(collabReducer(CONNECTING, open("editor"))).toEqual(connected("editor"));
    expect(collabReducer(CONNECTING, open("viewer"))).toEqual(connected("viewer"));
    expect(collabReducer(CONNECTING, open("owner"))).toEqual(connected("owner"));
  });

  it("reconnecting-once + open -> connected (that reconnect succeeded, back to normal)", () => {
    expect(collabReducer(RECONNECTING_ONCE, open("editor"))).toEqual(connected("editor"));
  });

  it("connected + open (re-validation) -> stays connected with the new role", () => {
    expect(collabReducer(connected("editor"), open("viewer"))).toEqual(connected("viewer"));
  });

  it("connected + open with the role unchanged -> returns the same state object (no extra re-render)", () => {
    const state = connected("editor");
    expect(collabReducer(state, open("editor"))).toBe(state);
  });
});

describe("collabReducer - close(REVOKED): two-strike revocation flow", () => {
  it("connected + close(REVOKED) -> reconnecting-once (first strike: refetch the token and connect once)", () => {
    expect(collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED))).toEqual(RECONNECTING_ONCE);
  });

  it("reconnecting-once + close(REVOKED) -> kicked (second strike: terminal)", () => {
    expect(collabReducer(RECONNECTING_ONCE, close(COLLAB_CLOSE_REVOKED))).toEqual(KICKED);
  });

  it("two consecutive REVOKED go from connected all the way to kicked", () => {
    const first = collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED));
    expect(first).toEqual(RECONNECTING_ONCE);
    expect(collabReducer(first, close(COLLAB_CLOSE_REVOKED))).toEqual(KICKED);
  });

  it("connecting + close(REVOKED) -> reconnecting-once (counts as the first strike even before open)", () => {
    expect(collabReducer(CONNECTING, close(COLLAB_CLOSE_REVOKED))).toEqual(RECONNECTING_ONCE);
  });
});

describe("collabReducer - token-role", () => {
  it("reconnecting-once + token-role 'none' -> kicked (refetching the token already shows access is lost)", () => {
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("none"))).toEqual(KICKED);
  });

  it("reconnecting-once + token-role other than 'none' -> stays reconnecting-once (connected only once open arrives)", () => {
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("editor"))).toBe(RECONNECTING_ONCE);
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("viewer"))).toBe(RECONNECTING_ONCE);
  });

  it("connected(editor) + token-role 'viewer' -> stays connected with the role downgraded to viewer", () => {
    expect(collabReducer(connected("editor"), tokenRole("viewer"))).toEqual(connected("viewer"));
  });

  it("connected(viewer) + token-role 'editor' -> stays connected with the role restored (permission recovery can only come through token-role)", () => {
    expect(collabReducer(connected("viewer"), tokenRole("editor"))).toEqual(connected("editor"));
  });

  it("connected + token-role with the role unchanged -> returns the same state object", () => {
    const state = connected("editor");
    expect(collabReducer(state, tokenRole("editor"))).toBe(state);
  });

  it("connected + token-role 'none' -> stays connected with role 'none' (read-only; the kick is decided by the server's REVOKED close)", () => {
    expect(collabReducer(connected("editor"), tokenRole("none"))).toEqual(connected("none"));
  });

  it("connecting + token-role -> no transition (the role is settled at open)", () => {
    expect(collabReducer(CONNECTING, tokenRole("editor"))).toBe(CONNECTING);
    expect(collabReducer(CONNECTING, tokenRole("none"))).toBe(CONNECTING);
  });
});

describe("collabReducer - close(NOTE_DELETED)", () => {
  it("any non-terminal state + close(NOTE_DELETED) -> deleted", () => {
    for (const state of [CONNECTING, connected("owner"), connected("viewer"), RECONNECTING_ONCE]) {
      expect(collabReducer(state, close(COLLAB_CLOSE_NOTE_DELETED))).toEqual(DELETED);
    }
  });
});

describe("collabReducer - close(other reason)", () => {
  it("connected + close(network disconnect) -> connecting (the provider's built-in backoff reconnects; not terminal)", () => {
    expect(collabReducer(connected("editor"), close(NETWORK_CLOSE))).toEqual(CONNECTING);
  });

  it("connected + close('Reset Connection') -> connecting", () => {
    expect(collabReducer(connected("editor"), close(RESET_CONNECTION))).toEqual(CONNECTING);
  });

  it("reconnecting-once + close(other reason) -> connecting (network trouble isn't a revocation signal)", () => {
    expect(collabReducer(RECONNECTING_ONCE, close(NETWORK_CLOSE))).toEqual(CONNECTING);
  });

  it("connecting + close(other reason) -> stays connecting (same object)", () => {
    expect(collabReducer(CONNECTING, close(NETWORK_CLOSE))).toBe(CONNECTING);
  });

  it("the revocation reason is compared by equality, not as a prefix/substring", () => {
    expect(collabReducer(connected("editor"), close(`${COLLAB_CLOSE_REVOKED}x`))).toEqual(CONNECTING);
    expect(collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED.toUpperCase()))).toEqual(CONNECTING);
    expect(collabReducer(CONNECTING, close(`x${COLLAB_CLOSE_NOTE_DELETED}`))).toEqual(CONNECTING);
  });
});

describe("collabReducer - terminal states are frozen", () => {
  it("kicked doesn't transition on any event (same object identity included)", () => {
    for (const event of ALL_EVENTS) {
      expect(collabReducer(KICKED, event)).toBe(KICKED);
    }
  });

  it("deleted doesn't transition on any event (a REVOKED close doesn't overwrite it with kicked either)", () => {
    for (const event of ALL_EVENTS) {
      expect(collabReducer(DELETED, event)).toBe(DELETED);
    }
  });

  it("kicked receiving NOTE_DELETED stays kicked (terminal freezing takes precedence over the deletion rule)", () => {
    expect(collabReducer(KICKED, close(COLLAB_CLOSE_NOTE_DELETED))).toBe(KICKED);
  });
});

describe("isTerminal", () => {
  it("only kicked/deleted are terminal", () => {
    expect(isTerminal(KICKED)).toBe(true);
    expect(isTerminal(DELETED)).toBe(true);
    expect(isTerminal(CONNECTING)).toBe(false);
    expect(isTerminal(RECONNECTING_ONCE)).toBe(false);
    expect(isTerminal(connected("editor"))).toBe(false);
  });
});

describe("#269 outdated (stale-tab gate)", () => {
  it("any non-terminal state + close(client-outdated) -> outdated; any later event stays in outdated", () => {
    for (const from of [INITIAL_COLLAB_STATE, { phase: "connected", role: "owner" } as const, { phase: "reconnecting-once" } as const]) {
      const s = collabReducer(from, { type: "close", reason: COLLAB_CLOSE_CLIENT_OUTDATED });
      expect(s).toEqual({ phase: "outdated" });
      expect(collabReducer(s, { type: "open", role: "owner" })).toBe(s);
      expect(collabReducer(s, { type: "close", reason: COLLAB_CLOSE_REVOKED })).toBe(s);
      expect(collabReducer(s, { type: "token-role", role: "none" })).toBe(s);
    }
  });
  it("outdated isn't terminal (doesn't trigger NotePage's toast + redirect), but stopsReconnect is true", () => {
    expect(isTerminal({ phase: "outdated" })).toBe(false);
    expect(stopsReconnect({ phase: "outdated" })).toBe(true);
    expect(stopsReconnect({ phase: "kicked" })).toBe(true);
    expect(stopsReconnect({ phase: "connected", role: "owner" })).toBe(false);
  });
});
