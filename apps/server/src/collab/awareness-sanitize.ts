// #312: awareness is client-supplied and forgeable, so each state is rebuilt from the
// connection's verified identity; the client contributes only a valid cursor.
// Relies on Hocuspocus 4.5.0: decoded awareness maps are re-encoded from their keys (in-place
// edits stick), and getClients(conn) is the live Set removeConnection uses, except once the
// connection is removed, when it returns a throwaway Set.
import {
  PRESENCE_FIELD,
  collabUserColor,
  parseAwarenessCursor,
  type AvatarRef,
  type PresenceRole,
  type UserPresenceField,
} from "@knotebook/shared";

export const MAX_AWARENESS_CLIENTS_PER_CONNECTION = 1;

export const SERVER_PRESENCE_ORIGIN = "ai-presence";

export interface ConnectionPresence {
  name: string;
  avatar: AvatarRef | null;
  since: number;
  role: PresenceRole;
}

export type AwarenessIssue =
  | "foreign-client"
  | "server-client"
  | "client-limit"
  | "user-mismatch"
  | "bad-cursor"
  | "no-identity";

export interface AwarenessConn {
  context?: { userId?: unknown };
}

export interface AwarenessDoc {
  awareness: { states: ReadonlyMap<number, unknown> };
  getConnections(): AwarenessConn[];
  getClients(connection: AwarenessConn): Set<number>;
}

export interface SanitizeInput {
  states: Map<number, Record<string, unknown>>;
  document: AwarenessDoc;
  connection: AwarenessConn | undefined;
  userId: string | undefined;
  presence: ConnectionPresence | undefined;
  readOnly: boolean;
  serverOwned: ReadonlySet<number>;
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Mutates `states` in place and never throws. Map order decides which new id in a batch hits the limit. */
export function sanitizeInboundAwareness(input: SanitizeInput): AwarenessIssue[] {
  const { states, document, connection, userId, presence, readOnly, serverOwned } = input;
  if (!connection || userId === undefined || !presence) {
    states.clear();
    return ["no-identity"];
  }
  const connections = document.getConnections();
  if (!connections.includes(connection)) {
    // Removed connection: registration would go nowhere and leave state no connection owns.
    states.clear();
    return ["no-identity"];
  }
  const issues: AwarenessIssue[] = [];
  const mine = document.getClients(connection);

  for (const [id, state] of [...states]) {
    // The temporary Awareness's own `{}` entry, or an empty client state.
    if (!isPlainObject(state) || Object.keys(state).length === 0) {
      states.delete(id);
      continue;
    }
    if (serverOwned.has(id)) {
      states.delete(id);
      mine.delete(id);
      issues.push("server-client");
      continue;
    }
    const owner: AwarenessConn | undefined = mine.has(id) ? connection : connections.find((c) => document.getClients(c).has(id));
    if (owner === connection) {
    } else if (owner) {
      if (owner.context?.userId === userId) {
        if (mine.size >= MAX_AWARENESS_CLIENTS_PER_CONNECTION) {
          // A takeover counts as an add, or two connections could swap ids to grow without bound.
          states.delete(id);
          issues.push("client-limit");
          continue;
        }
        document.getClients(owner).delete(id);
        mine.add(id);
      } else {
        states.delete(id);
        issues.push("foreign-client");
        continue;
      }
    } else if (document.awareness.states.has(id)) {
      // No connection owns it but the document has it: the server wrote it.
      states.delete(id);
      issues.push("server-client");
      continue;
    } else if (mine.size >= MAX_AWARENESS_CLIENTS_PER_CONNECTION) {
      states.delete(id);
      issues.push("client-limit");
      continue;
    } else {
      // Also rebinds a reconnecting client to this connection, so its state is removed on close.
      mine.add(id);
    }

    const claimed = isPlainObject(state.user) ? state.user.id : undefined;
    if (typeof claimed === "string" && claimed !== userId) issues.push("user-mismatch");
    const cursor = readOnly ? null : parseAwarenessCursor(state.cursor);
    if (!readOnly && state.cursor != null && cursor === null) issues.push("bad-cursor");

    const field: UserPresenceField = {
      v: 1,
      kind: "user",
      role: presence.role,
      avatar: presence.avatar,
      since: presence.since,
    };
    states.set(id, {
      user: { id: userId, name: presence.name, color: collabUserColor(userId) },
      [PRESENCE_FIELD]: field,
      cursor,
    });
  }
  return issues;
}

export class ServerOwnedClients {
  private readonly byDocument = new WeakMap<object, Set<number>>();

  mark(document: object, ids: readonly number[]): void {
    let set = this.byDocument.get(document);
    if (!set) {
      set = new Set();
      this.byDocument.set(document, set);
    }
    for (const id of ids) set.add(id);
  }

  get(document: object): ReadonlySet<number> {
    return this.byDocument.get(document) ?? new Set();
  }
}
