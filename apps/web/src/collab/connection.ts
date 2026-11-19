import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, type Role } from "@knotebook/shared";

// #269: client-internal close reason (the server never sends it); `useCollab` maps the wire `client-outdated` to it.
export const COLLAB_CLOSE_CLIENT_OUTDATED = "knotebook:client-outdated";

// `role` comes from the top-level `role` field of the latest token response; never decode the JWT (it is the credential between the server and Hocuspocus).
export type CollabState =
  | { phase: "connecting" }
  | { phase: "connected"; role: Role }
  | { phase: "reconnecting-once" }
  | { phase: "kicked" }
  | { phase: "deleted" }
  | { phase: "outdated" };

/**
 * Hocuspocus hard-codes close code 1000, so only the `reason` string matters (`APP_CLOSE_CODE` in `apps/server/src/collab/server.ts`).
 * `token-role` is the only signal that reaches the client when permission is restored (`setReadOnly(false)`): the server sends no notification, only the next token round trip carries the new role.
 */
export type CollabEvent = { type: "open"; role: Role } | { type: "close"; reason: string } | { type: "token-role"; role: Role };

export const INITIAL_COLLAB_STATE: CollabState = { phase: "connecting" };

export function isTerminal(state: CollabState): boolean {
  return state.phase === "kicked" || state.phase === "deleted";
}

// ⚠ `outdated` must not be added to `isTerminal`: that would trigger NotePage's toast + redirect to `/`.
export function stopsReconnect(state: CollabState): boolean {
  return isTerminal(state) || state.phase === "outdated";
}

export function canEdit(role: Role): boolean {
  return role === "owner" || role === "editor";
}

/**
 * The order of the checks is the priority and part of the contract.
 * - Terminal freeze first: `kicked` / `deleted` / `outdated` return the original object, so even `close(NOTE_DELETED)` can't overwrite `kicked` (first one wins).
 * - `connecting` counts as a first REVOKED strike too: filing it on the "reconnect chance not yet used" side is the safe direction.
 * - Any other close reason (network drop, "Reset Connection") → `connecting`, which resets the `reconnecting-once` window: a network problem isn't a revocation signal;
 *   if access really was revoked the next connect receives REVOKED again and still converges to `kicked`.
 * - `reconnecting-once` + token role `'none'` → `kicked`: this is the path revocation really takes, since on reconnect the server's `onAuthenticate` throws permission-denied instead of sending another CLOSE(REVOKED).
 * - `connected` + token role only swaps the role (`'none'` too: `canEdit` is false); kicking is left to the server's REVOKED close, the client doesn't infer the authorization result.
 * Unchanged state returns the same object so `useReducer` doesn't re-render.
 */
export function collabReducer(state: CollabState, event: CollabEvent): CollabState {
  if (stopsReconnect(state)) return state;

  if (event.type === "close") {
    if (event.reason === COLLAB_CLOSE_CLIENT_OUTDATED) return { phase: "outdated" };
    if (event.reason === COLLAB_CLOSE_NOTE_DELETED) return { phase: "deleted" };
    if (event.reason === COLLAB_CLOSE_REVOKED) {
      return state.phase === "reconnecting-once" ? { phase: "kicked" } : { phase: "reconnecting-once" };
    }
    return state.phase === "connecting" ? state : { phase: "connecting" };
  }

  if (event.type === "token-role") {
    if (state.phase === "reconnecting-once") {
      return event.role === "none" ? { phase: "kicked" } : state;
    }
    if (state.phase === "connected") {
      return state.role === event.role ? state : { phase: "connected", role: event.role };
    }
    return state;
  }

  if (state.phase === "connected" && state.role === event.role) return state;
  return { phase: "connected", role: event.role };
}
