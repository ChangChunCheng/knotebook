import { useEffect } from "react";
import type { Awareness } from "y-protocols/awareness";
import { PRESENCE_FIELD, type AvatarRef, type Role, type UserPresenceField } from "@knotebook/shared";

/**
 * Writes this tab's `knotebook` awareness field (BlockNote owns `user`, which this doesn't touch). y-protocols'
 * `applyAwarenessUpdate` only accepts a state with `currClock < clock`, which leaves two reconnect holes in
 * y-protocols/Hocuspocus, patched here on two provider events:
 * - `authenticated` (fires on every connect): the provider's `onOpen` resends the local state with the old clock,
 *   but the server already removed it when the old connection closed (@hocuspocus/server
 *   `Document.removeConnection`) without bumping the clock, so the resend is ignored until the 15 s renew.
 *   Rewriting the same value bumps the clock; the server takes it as `updated` and this user reappears in others'
 *   avatar rows at once (pinned by a test).
 * - `close`: provider `onClose` deletes remote states but not their meta clocks (@hocuspocus/provider 4.5.0
 *   `HocuspocusProvider.onClose`; its listener is registered before the `close` event is forwarded, so states are
 *   already gone when this runs), so after reconnect the server's same-clock state is ignored locally. Deleting
 *   meta for remote clients without a state makes it arrive as `added` (pinned by a test with a control case).
 * The value effect dedupes against the current local value: on reconnect role goes owner -> null -> owner and StrictMode mounts twice.
 * Only awareness is written; connect/disconnect and useCollab's restart scheduling are untouched.
 */

type ConnectionEvent = "authenticated" | "close";

export type PresenceProvider = {
  awareness?: Awareness | null;
  on?(event: ConnectionEvent, fn: () => void): unknown;
  off?(event: ConnectionEvent, fn: () => void): unknown;
};

/** Module-level so the last written identity and its `since` survive switching notes and NotePage remounts in the same tab. */
let lastIdentity: { name: string; avatarId: string | null; avatarV: number | null; since: number } | null = null;

function sinceFor(name: string, avatarId: string | null, avatarV: number | null): number {
  if (lastIdentity && lastIdentity.name === name && lastIdentity.avatarId === avatarId && lastIdentity.avatarV === avatarV) {
    return lastIdentity.since;
  }
  lastIdentity = { name, avatarId, avatarV, since: Date.now() };
  return lastIdentity.since;
}

export function resetLocalPresenceFieldForTest(): void {
  lastIdentity = null;
}

/** A null name, or a null/"none" role, writes nothing (the previous value stays); unchanged values aren't rewritten. */
export function useLocalPresenceField(input: {
  provider: PresenceProvider | null;
  role: Role | null;
  name: string | null;
  avatar: AvatarRef | null;
}): void {
  const { provider, role, name, avatar } = input;
  const awareness = provider?.awareness ?? null;
  const avatarId = avatar?.id ?? null;
  const avatarV = avatar?.v ?? null;

  useEffect(() => {
    if (awareness === null || name === null || role === null || role === "none") return;
    const value: UserPresenceField = {
      v: 1,
      kind: "user",
      role,
      avatar: avatarId !== null && avatarV !== null ? { id: avatarId, v: avatarV } : null,
      since: sinceFor(name, avatarId, avatarV),
    };
    const current: unknown = awareness.getLocalState()?.[PRESENCE_FIELD];
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    awareness.setLocalStateField(PRESENCE_FIELD, value);
  }, [awareness, role, name, avatarId, avatarV]);

  useEffect(() => {
    if (!provider?.on || awareness === null) return;
    const onAuthenticated = () => {
      const current: unknown = awareness.getLocalState()?.[PRESENCE_FIELD];
      if (current !== undefined) awareness.setLocalStateField(PRESENCE_FIELD, current);
    };
    const onClose = () => {
      for (const id of [...awareness.meta.keys()]) {
        if (id !== awareness.clientID && !awareness.states.has(id)) awareness.meta.delete(id);
      }
    };
    provider.on("authenticated", onAuthenticated);
    provider.on("close", onClose);
    return () => {
      provider.off?.("authenticated", onAuthenticated);
      provider.off?.("close", onClose);
    };
  }, [provider, awareness]);
}
