// The `knotebook` awareness field only grows (`v` versions it) and never carries URLs; avatars go as AvatarRef.
import type { AvatarRef } from "./avatar.js";
import { YDOC_FRAGMENT } from "./ydoc.js";

export const PRESENCE_FIELD = "knotebook";

export const AGENT_PRESENCE_COLOR = "#7c3aed";

// Hashed, not random, so a user has one color everywhere; fixed saturation and lightness stay readable in both themes.
export function collabUserColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 65% 45%)`;
}

export type PresenceRole = "owner" | "editor" | "viewer";

export interface UserPresenceField {
  v: 1;
  kind: "user";
  role: PresenceRole;
  avatar: AvatarRef | null;
  since: number;
}

export interface AgentPresenceField {
  v: 1;
  kind: "agent";
  handle: string;
  label: string;
}

export type PresenceField = UserPresenceField | AgentPresenceField;

export interface RelativePositionJson {
  type?: { client: number; clock: number };
  tname?: string;
  item?: { client: number; clock: number };
  assoc?: number;
}

export interface AwarenessCursor {
  anchor: RelativePositionJson;
  head: RelativePositionJson;
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function parseId(x: unknown): { client: number; clock: number } | null {
  if (!isObject(x)) return null;
  const { client, clock } = x;
  if (typeof client !== "number" || !Number.isInteger(client) || client < 0 || client > 0xffffffff) return null;
  if (typeof clock !== "number" || !Number.isSafeInteger(clock) || clock < 0) return null;
  return { client, clock };
}

function parsePosition(x: unknown): RelativePositionJson | null {
  if (!isObject(x)) return null;
  // y-prosemirror sends the RelativePosition object itself, with null for unused fields; treat null as absent.
  const hasType = x.type != null;
  const hasTname = x.tname != null;
  if (hasType === hasTname) return null;
  const out: RelativePositionJson = {};
  if (hasType) {
    const type = parseId(x.type);
    if (!type) return null;
    out.type = type;
  } else {
    if (x.tname !== YDOC_FRAGMENT) return null;
    out.tname = YDOC_FRAGMENT;
  }
  if (x.item != null) {
    const item = parseId(x.item);
    if (!item) return null;
    out.item = item;
  }
  if (x.assoc !== undefined) {
    if (typeof x.assoc !== "number" || !Number.isSafeInteger(x.assoc)) return null;
    out.assoc = x.assoc;
  }
  return out;
}

// Awareness is client-reported and y-prosemirror throws on a malformed cursor, so check before reading `cursor`.
// Rebuilt from known fields only, which bounds its size. Never throws; invalid input gives null.
export function parseAwarenessCursor(x: unknown): AwarenessCursor | null {
  if (!isObject(x)) return null;
  const anchor = parsePosition(x.anchor);
  const head = parsePosition(x.head);
  return anchor && head ? { anchor, head } : null;
}
