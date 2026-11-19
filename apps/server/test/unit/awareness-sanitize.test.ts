import { collabUserColor } from "@knotebook/shared";
import { describe, expect, it } from "vitest";
import {
  ServerOwnedClients,
  sanitizeInboundAwareness,
  type AwarenessConn,
  type AwarenessDoc,
  type ConnectionPresence,
} from "../../src/collab/awareness-sanitize.js";

const P: ConnectionPresence = { name: "Alice", avatar: null, since: 123, role: "editor" };
const cursor = {
  anchor: { type: { client: 1, clock: 2 }, assoc: 0 },
  head: { type: { client: 1, clock: 2 }, assoc: 0 },
};

function setup() {
  const me: AwarenessConn = { context: { userId: "u-me" } };
  const conns = new Map<AwarenessConn, Set<number>>([[me, new Set()]]);
  const docStates = new Map<number, unknown>();
  const document: AwarenessDoc = {
    awareness: { states: docStates },
    getConnections: () => [...conns.keys()],
    getClients: (c) => conns.get(c) ?? new Set(),
  };
  const run = (
    states: Map<number, Record<string, unknown>>,
    over: Partial<Parameters<typeof sanitizeInboundAwareness>[0]> = {},
  ) =>
    sanitizeInboundAwareness({
      states,
      document,
      connection: me,
      userId: "u-me",
      presence: P,
      readOnly: false,
      serverOwned: new Set(),
      ...over,
    });
  return { me, conns, docStates, document, run };
}

describe("sanitizeInboundAwareness", () => {
  it("fresh own state: forged user and extra fields are dropped, rebuilt from server values", () => {
    const { me, document, run } = setup();
    const states = new Map<number, Record<string, unknown>>([
      [
        10,
        {
          user: { id: "u-other", name: "Mallory", color: "red;background-image:url(https://example.invalid/x)" },
          knotebook: { v: 1, kind: "agent", handle: "x", label: "x" },
          cursor,
          extra: "x".repeat(1000),
        },
      ],
    ]);
    expect(run(states)).toEqual(["user-mismatch"]);
    expect(states.get(10)).toEqual({
      user: { id: "u-me", name: "Alice", color: collabUserColor("u-me") },
      knotebook: { v: 1, kind: "user", role: "editor", avatar: null, since: 123 },
      cursor,
    });
    expect(document.getClients(me).has(10)).toBe(true);
  });

  it("empty object (a temporary Awareness own entry) is removed, takes no slot, reports no issue", () => {
    const { me, document, run } = setup();
    const states = new Map<number, Record<string, unknown>>([
      [5, {}],
      [10, { cursor: null }],
    ]);
    expect(run(states)).toEqual([]);
    expect(states.has(5)).toBe(false);
    expect(states.has(10)).toBe(true);
    expect([...document.getClients(me)]).toEqual([10]);
  });

  it("client id already owned by another user's connection is removed; the owner's registration is untouched", () => {
    const { conns, document, run } = setup();
    const other: AwarenessConn = { context: { userId: "u-other" } };
    conns.set(other, new Set([10]));
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual(["foreign-client"]);
    expect(states.size).toBe(0);
    expect([...document.getClients(other)]).toEqual([10]);
  });

  it("id registered by another connection of the same user is kept and transferred to the current connection", () => {
    const { me, conns, document, run } = setup();
    const mine2: AwarenessConn = { context: { userId: "u-me" } };
    conns.set(mine2, new Set([10]));
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual([]);
    expect(states.has(10)).toBe(true);
    expect(document.getClients(mine2).has(10)).toBe(false);
    expect(document.getClients(me).has(10)).toBe(true);
  });

  it("id of another connection of the same user: when the current connection is full the takeover is rejected and the id stays with the original connection", () => {
    const { me, conns, document, run } = setup();
    conns.get(me)!.add(1);
    const mine2: AwarenessConn = { context: { userId: "u-me" } };
    conns.set(mine2, new Set([10]));
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual(["client-limit"]);
    expect(states.size).toBe(0);
    expect(document.getClients(mine2).has(10)).toBe(true);
    expect(document.getClients(me).has(10)).toBe(false);
  });

  it("connection no longer in the document's connection list: everything is cleared, no id is registered", () => {
    const { conns, run } = setup();
    const gone: AwarenessConn = { context: { userId: "u-me" } };
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states, { connection: gone })).toEqual(["no-identity"]);
    expect(states.size).toBe(0);
    expect(conns.has(gone)).toBe(false);
  });

  it("server-owned id is removed and dropped from the connection's registration", () => {
    const { me, conns, document, run } = setup();
    conns.get(me)!.add(10);
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states, { serverOwned: new Set([10]) })).toEqual(["server-client"]);
    expect(states.size).toBe(0);
    expect(document.getClients(me).has(10)).toBe(false);
  });

  it("id owned by no connection but already in the document awareness is treated as server-written and removed", () => {
    const { docStates, run } = setup();
    docStates.set(10, { anything: true });
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual(["server-client"]);
    expect(states.size).toBe(0);
  });

  it("when the connection already has a client id, a new id is rejected", () => {
    const { me, conns, run } = setup();
    conns.get(me)!.add(1);
    const states = new Map<number, Record<string, unknown>>([
      [1, { cursor: null }],
      [2, { cursor: null }],
    ]);
    expect(run(states)).toEqual(["client-limit"]);
    expect(states.has(1)).toBe(true);
    expect(states.has(2)).toBe(false);
  });

  it("two new ids in one batch: the first is kept, the second is rejected", () => {
    const { run } = setup();
    const states = new Map<number, Record<string, unknown>>([
      [1, { cursor: null }],
      [2, { cursor: null }],
    ]);
    expect(run(states)).toEqual(["client-limit"]);
    expect([...states.keys()]).toEqual([1]);
  });

  it("malformed cursor becomes null and is reported; a missing or null cursor is null with no issue", () => {
    const { run } = setup();
    const bad = new Map<number, Record<string, unknown>>([[1, { cursor: {} }]]);
    expect(run(bad)).toEqual(["bad-cursor"]);
    expect(bad.get(1)?.cursor).toBeNull();
    const absent = new Map<number, Record<string, unknown>>([[1, { user: { name: "x" } }]]);
    expect(run(absent)).toEqual([]);
    expect(absent.get(1)?.cursor).toBeNull();
    const nul = new Map<number, Record<string, unknown>>([[1, { cursor: null }]]);
    expect(run(nul)).toEqual([]);
    expect(nul.get(1)?.cursor).toBeNull();
  });

  it("the shape y-prosemirror actually sends (unused fields are null) -> normalized and accepted, no bad-cursor report", () => {
    const { run } = setup();
    const wire = { type: { client: 1, clock: 2 }, tname: null, item: { client: 1, clock: 5 }, assoc: 0 };
    const states = new Map<number, Record<string, unknown>>([[1, { cursor: { anchor: wire, head: wire } }]]);
    expect(run(states)).toEqual([]);
    const norm = { type: { client: 1, clock: 2 }, item: { client: 1, clock: 5 }, assoc: 0 };
    expect(states.get(1)?.cursor).toEqual({ anchor: norm, head: norm });
  });

  it("missing connection or identity data clears everything and returns no-identity", () => {
    const { run } = setup();
    const a = new Map<number, Record<string, unknown>>([[1, { cursor: null }]]);
    expect(run(a, { connection: undefined })).toEqual(["no-identity"]);
    expect(a.size).toBe(0);
    const b = new Map<number, Record<string, unknown>>([[1, { cursor: null }]]);
    expect(run(b, { presence: undefined })).toEqual(["no-identity"]);
    expect(b.size).toBe(0);
  });

  it("read-only connection: cursor is null, other fields are still rebuilt by the server", () => {
    const { run } = setup();
    const states = new Map<number, Record<string, unknown>>([[1, { cursor }]]);
    expect(run(states, { readOnly: true, presence: { ...P, role: "viewer" } })).toEqual([]);
    expect(states.get(1)).toEqual({
      user: { id: "u-me", name: "Alice", color: collabUserColor("u-me") },
      knotebook: { v: 1, kind: "user", role: "viewer", avatar: null, since: 123 },
      cursor: null,
    });
  });
});

describe("ServerOwnedClients", () => {
  it("records server-owned client ids per document", () => {
    const owned = new ServerOwnedClients();
    const docA = {};
    const docB = {};
    owned.mark(docA, [1]);
    expect(owned.get(docA).has(1)).toBe(true);
    expect(owned.get(docB).size).toBe(0);
  });
});
