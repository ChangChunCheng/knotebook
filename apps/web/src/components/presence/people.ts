import {
  AGENT_PRESENCE_COLOR,
  PRESENCE_FIELD,
  collabUserColor,
  parseAvatarRef,
  type AvatarRef,
  type PresenceRole,
} from "@knotebook/shared";

/**
 * Header avatar row list (#293). Awareness is client-reported, so every field is untrusted: the `knotebook` field only with
 * `v === 1`, roles only from a whitelist, avatars always via `parseAvatarRef`, colors always computed here (never
 * `state.user.color`).
 */

export type PresenceKey = `user:${string}` | `agent:${number}`;

interface Common {
  key: PresenceKey;
  color: string;
  hasCursor: boolean;
}

export interface UserPresencePerson extends Common {
  kind: "user";
  userId: string;
  name: string;
  role: PresenceRole | null;
  avatar: AvatarRef | null;
}

export interface AgentPresencePerson extends Common {
  kind: "agent";
  clientId: number;
  handle: string;
  label: string;
}

export type PresencePerson = UserPresencePerson | AgentPresencePerson;

const ROLE_RANK: Record<PresenceRole, number> = { viewer: 1, editor: 2, owner: 3 };

type Entry =
  | { kind: "agent"; clientId: number; handle: string; label: string; cursor: unknown }
  | {
      kind: "user";
      clientId: number;
      userId: string;
      name: string;
      role: PresenceRole | null;
      avatar: AvatarRef | null;
      since: number;
      cursor: unknown;
    };

type UserEntry = Extract<Entry, { kind: "user" }>;

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x !== "";
}

function parseRole(x: unknown): PresenceRole | null {
  return x === "owner" || x === "editor" || x === "viewer" ? x : null;
}

function higherRole(a: PresenceRole | null, b: PresenceRole | null): PresenceRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

function parseEntry(clientId: number, state: unknown, myClientId: number, myUserId: string): Entry | null {
  if (clientId === myClientId) return null;
  if (typeof state !== "object" || state === null) return null;
  const s = state as { user?: unknown; cursor?: unknown; [PRESENCE_FIELD]?: unknown };
  const raw = s[PRESENCE_FIELD];
  const field =
    typeof raw === "object" && raw !== null && (raw as { v?: unknown }).v === 1
      ? (raw as { kind?: unknown; role?: unknown; avatar?: unknown; since?: unknown; handle?: unknown; label?: unknown })
      : null;
  const cursor = s.cursor ?? null;
  if (field?.kind === "agent") {
    // The server always sends handle and label; missing means forged or corrupt, so skip the entry.
    if (!isNonEmptyString(field.handle) || !isNonEmptyString(field.label)) return null;
    return { kind: "agent", clientId, handle: field.handle, label: field.label, cursor };
  }
  const user = s.user;
  if (typeof user !== "object" || user === null) return null;
  const { id, name } = user as { id?: unknown; name?: unknown };
  if (!isNonEmptyString(id) || id === myUserId) return null;
  const isUserField = field?.kind === "user";
  const since = isUserField && typeof field.since === "number" && Number.isFinite(field.since) ? field.since : -Infinity;
  return {
    kind: "user",
    clientId,
    userId: id,
    name: typeof name === "string" ? name : "",
    role: isUserField ? parseRole(field.role) : null,
    avatar: isUserField ? parseAvatarRef(field.avatar) : null,
    since,
    cursor,
  };
}

function entryKey(e: Entry): PresenceKey {
  return e.kind === "agent" ? `agent:${e.clientId}` : `user:${e.userId}`;
}

/** Larger `since` wins; ties go to the larger clientID (only for stability). */
function newer(a: UserEntry, b: UserEntry): UserEntry {
  if (a.since !== b.since) return a.since > b.since ? a : b;
  return a.clientId > b.clientId ? a : b;
}

function entries(states: ReadonlyMap<number, unknown>, myClientId: number, myUserId: string): Entry[] {
  const out: Entry[] = [];
  for (const [clientId, state] of states) {
    const e = parseEntry(clientId, state, myClientId, myUserId);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Excludes my clientID and any state with my user id (my other tabs). One item per AI clientID; humans merged by user
 * id. Sorted by key only: display order is `orderBySeen`'s job.
 */
export function presencePeople(states: ReadonlyMap<number, unknown>, myClientId: number, myUserId: string): PresencePerson[] {
  const people = new Map<PresenceKey, PresencePerson>();
  const latest = new Map<PresenceKey, UserEntry>();
  for (const e of entries(states, myClientId, myUserId)) {
    const key = entryKey(e);
    const hasCursor = e.cursor != null;
    if (e.kind === "agent") {
      people.set(key, { kind: "agent", key, clientId: e.clientId, handle: e.handle, label: e.label, color: AGENT_PRESENCE_COLOR, hasCursor });
      continue;
    }
    const prev = people.get(key) as UserPresencePerson | undefined;
    const prevLatest = latest.get(key);
    const best = prevLatest ? newer(prevLatest, e) : e;
    latest.set(key, best);
    const role = prev ? higherRole(prev.role, e.role) : e.role;
    people.set(key, {
      kind: "user",
      key,
      userId: e.userId,
      name: best.name,
      role,
      avatar: best.avatar,
      color: collabUserColor(e.userId),
      hasCursor: hasCursor || (prev?.hasCursor ?? false),
    });
  }
  return [...people.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Call at click time: reads the live states. */
export function presenceCursor(
  states: ReadonlyMap<number, unknown>,
  key: PresenceKey,
  myClientId: number,
  myUserId: string,
): unknown | null {
  let best: Entry | null = null;
  for (const e of entries(states, myClientId, myUserId)) {
    if (e.cursor == null || entryKey(e) !== key) continue;
    // An AI key carries the clientID so it has one state; only humans need the largest-`since` pick.
    best = best !== null && best.kind === "user" && e.kind === "user" ? newer(best, e) : e;
  }
  return best?.cursor ?? null;
}

/** Arrival order, left to right; someone who leaves and comes back goes last. */
export function orderBySeen(
  seen: ReadonlyMap<PresenceKey, number>,
  people: readonly PresencePerson[],
  nextSeq: number,
): { seen: Map<PresenceKey, number>; people: PresencePerson[]; nextSeq: number } {
  const next = new Map<PresenceKey, number>();
  let seq = nextSeq;
  for (const p of people) {
    const s = seen.get(p.key);
    if (s === undefined) {
      next.set(p.key, seq);
      seq += 1;
    } else {
      next.set(p.key, s);
    }
  }
  const ordered = [...people].sort((a, b) => next.get(a.key)! - next.get(b.key)!);
  return { seen: next, people: ordered, nextSeq: seq };
}

/** Cursor position is excluded: only whether one exists. */
export function presenceSignature(people: readonly PresencePerson[]): string {
  return JSON.stringify(
    people.map((p) =>
      p.kind === "agent"
        ? [p.key, p.handle, p.label, p.hasCursor]
        : [p.key, p.name, p.role, p.avatar?.id ?? null, p.avatar?.v ?? null, p.hasCursor],
    ),
  );
}

export const PRESENCE_CAPACITY = { wide: 5, narrow: 2, compact: 0 } as const;

function fit(total: number, capacity: number): { shown: number; more: number } {
  if (total > capacity) {
    const shown = capacity - 1;
    return { shown, more: total - shown };
  }
  return { shown: total, more: 0 };
}

/** Compact (phone width) shows no avatars, only "+N" for everyone; with nobody else `more` is 0 and nothing renders. */
export function presenceLayout(total: number): {
  wide: { shown: number; more: number };
  narrow: { shown: number; more: number };
  compact: { shown: number; more: number };
} {
  return {
    wide: fit(total, PRESENCE_CAPACITY.wide),
    narrow: fit(total, PRESENCE_CAPACITY.narrow),
    compact: { shown: 0, more: total },
  };
}

export { firstGrapheme, hasVisibleText } from "@/lib/first-grapheme";
