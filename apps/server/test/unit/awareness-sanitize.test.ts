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
  it("U1 全新的自己狀態：偽造的 user 與多餘欄位被丟掉，改用 server 值重建", () => {
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

  it("U2 空物件（暫存 Awareness 自己的條目）被移除、不佔名額、不報問題", () => {
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

  it("U3 已屬於其他使用者連線的 client id 被移除，對方的登記不動", () => {
    const { conns, document, run } = setup();
    const other: AwarenessConn = { context: { userId: "u-other" } };
    conns.set(other, new Set([10]));
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual(["foreign-client"]);
    expect(states.size).toBe(0);
    expect([...document.getClients(other)]).toEqual([10]);
  });

  it("U4 同一使用者另一條連線登記的 id：保留並移轉給目前連線", () => {
    const { me, conns, document, run } = setup();
    const mine2: AwarenessConn = { context: { userId: "u-me" } };
    conns.set(mine2, new Set([10]));
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual([]);
    expect(states.has(10)).toBe(true);
    expect(document.getClients(mine2).has(10)).toBe(false);
    expect(document.getClients(me).has(10)).toBe(true);
  });

  it("U13 同一使用者另一條連線的 id：目前連線已滿時接手被拒，id 留在原連線", () => {
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

  it("U14 已不在文件連線清單內的連線：整批清空，不登記任何 id", () => {
    const { conns, run } = setup();
    const gone: AwarenessConn = { context: { userId: "u-me" } };
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states, { connection: gone })).toEqual(["no-identity"]);
    expect(states.size).toBe(0);
    expect(conns.has(gone)).toBe(false);
  });

  it("U5 server 擁有的 id 被移除，並從連線的登記中拿掉", () => {
    const { me, conns, document, run } = setup();
    conns.get(me)!.add(10);
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states, { serverOwned: new Set([10]) })).toEqual(["server-client"]);
    expect(states.size).toBe(0);
    expect(document.getClients(me).has(10)).toBe(false);
  });

  it("U6 沒有連線擁有、但文件 awareness 已有的 id 視為 server 寫的而移除", () => {
    const { docStates, run } = setup();
    docStates.set(10, { anything: true });
    const states = new Map<number, Record<string, unknown>>([[10, { cursor: null }]]);
    expect(run(states)).toEqual(["server-client"]);
    expect(states.size).toBe(0);
  });

  it("U7 連線已有一個 client id 時，再來一個新 id 被拒", () => {
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

  it("U8 同一批兩個新 id：第一個保留、第二個被拒", () => {
    const { run } = setup();
    const states = new Map<number, Record<string, unknown>>([
      [1, { cursor: null }],
      [2, { cursor: null }],
    ]);
    expect(run(states)).toEqual(["client-limit"]);
    expect([...states.keys()]).toEqual([1]);
  });

  it("U9 格式錯誤的 cursor 變 null 並回報；缺少或 null 的 cursor 為 null 且無問題", () => {
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

  it("U10 缺連線或缺身分資料時清空全部並回 no-identity", () => {
    const { run } = setup();
    const a = new Map<number, Record<string, unknown>>([[1, { cursor: null }]]);
    expect(run(a, { connection: undefined })).toEqual(["no-identity"]);
    expect(a.size).toBe(0);
    const b = new Map<number, Record<string, unknown>>([[1, { cursor: null }]]);
    expect(run(b, { presence: undefined })).toEqual(["no-identity"]);
    expect(b.size).toBe(0);
  });

  it("U12 唯讀連線：cursor 一律為 null，其餘欄位仍由 server 重建", () => {
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
  it("U11 依文件分開記錄 server 擁有的 client id", () => {
    const owned = new ServerOwnedClients();
    const docA = {};
    const docB = {};
    owned.mark(docA, [1]);
    expect(owned.get(docA).has(1)).toBe(true);
    expect(owned.get(docB).size).toBe(0);
  });
});
