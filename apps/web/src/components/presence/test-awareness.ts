// 測試專用（只給 *.test.* import，正式程式碼不得引用）：以真的 y-protocols `Awareness` 注入遠端狀態，
// 參數形同 server `notes/editing/presence.ts` 的 `emit`；`fakeProvider` 形同 `NotePage.test.tsx` 的 `createStubProvider` 加上 `awareness`。
import type { Awareness } from "y-protocols/awareness";
import { AGENT_PRESENCE_COLOR, PRESENCE_FIELD, type AvatarRef, type PresenceRole } from "@knotebook/shared";

export function setRemote(awareness: Awareness, clientId: number, state: Record<string, unknown>): void {
  const prev = awareness.meta.get(clientId);
  const existed = awareness.states.has(clientId);
  awareness.states.set(clientId, state);
  awareness.meta.set(clientId, { clock: (prev?.clock ?? 0) + 1, lastUpdated: Date.now() });
  awareness.emit("change", [{ added: existed ? [] : [clientId], updated: existed ? [clientId] : [], removed: [] }, "remote"]);
}

export function removeRemote(awareness: Awareness, clientId: number): void {
  awareness.states.delete(clientId);
  awareness.emit("change", [{ added: [], updated: [], removed: [clientId] }, "remote"]);
}

export interface UserStateOptions {
  role?: PresenceRole | string;
  since?: number;
  avatar?: AvatarRef | unknown;
  cursor?: unknown;
  /** false：舊版 client，沒有 `knotebook` 欄。 */
  field?: boolean;
  color?: string;
  beat?: number;
}

export function userState(userId: string, name: string, opts: UserStateOptions = {}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    user: { id: userId, name, color: opts.color ?? "#000000" },
    cursor: opts.cursor ?? null,
  };
  if (opts.beat !== undefined) state.beat = opts.beat;
  if (opts.field !== false) {
    state[PRESENCE_FIELD] = {
      v: 1,
      kind: "user",
      role: opts.role ?? "editor",
      avatar: opts.avatar ?? null,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
    };
  }
  return state;
}

export function agentState(handle: string, label: string, opts: { cursor?: unknown; color?: string } = {}): Record<string, unknown> {
  return {
    user: { name: `${handle} (${label})`, color: opts.color ?? AGENT_PRESENCE_COLOR },
    cursor: opts.cursor ?? null,
    [PRESENCE_FIELD]: { v: 1, kind: "agent", handle, label },
  };
}

type Listener = () => void;

export interface FakeProvider {
  awareness: Awareness;
  on(event: string, fn: Listener): void;
  off(event: string, fn: Listener): void;
  emit(event: string): void;
}

export function fakeProvider(awareness: Awareness): FakeProvider {
  const listeners = new Map<string, Set<Listener>>();
  return {
    awareness,
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event) {
      listeners.get(event)?.forEach((fn) => fn());
    },
  };
}
