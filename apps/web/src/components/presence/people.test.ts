import { describe, expect, it } from "vitest";
import { AGENT_PRESENCE_COLOR, collabUserColor } from "@knotebook/shared";
import {
  firstGrapheme,
  hasVisibleText,
  orderBySeen,
  presenceCursor,
  presenceLayout,
  presencePeople,
  presenceSignature,
  type PresencePerson,
  type UserPresencePerson,
} from "./people";
import { agentState, userState } from "./test-awareness";
import { firstGrapheme as libFirstGrapheme, hasVisibleText as libHasVisibleText } from "@/lib/first-grapheme";

// #293: list, merging, ordering, signature, capacity; the first grapheme is only checked as a re-export. me = "u-me", this tab's clientID = 1.
const ME = "u-me";
const MY_CLIENT = 1;
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CURSOR = { anchor: { a: 1 }, head: { h: 1 } };

function people(entries: [number, unknown][]): PresencePerson[] {
  return presencePeople(new Map(entries), MY_CLIENT, ME);
}

function onlyUser(entries: [number, unknown][]): UserPresencePerson {
  const list = people(entries);
  expect(list).toHaveLength(1);
  const [p] = list;
  if (p.kind !== "user") throw new Error("expected user");
  return p;
}

describe("presencePeople", () => {
  it("this client's own clientID is skipped (even if user.id is someone else's)", () => {
    expect(people([[MY_CLIENT, userState("u-a", "Ann")]])).toEqual([]);
  });

  it("another tab of mine is skipped; an AI under my own credential still counts as one entry", () => {
    const list = people([
      [2, userState(ME, "Me")],
      [3, agentState("me", "Claude")],
    ]);
    expect(list.map((p) => p.key)).toEqual(["agent:3"]);
  });

  it("tabs of the same person merge: the higher role wins, the name comes from the larger since; an old-version client does not change the result", () => {
    const merged = [
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200 })],
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100 })],
    ] as [number, unknown][];
    const expected = { key: "user:u-a", userId: "u-a", role: "editor", name: "Ann 新" };
    expect(onlyUser(merged)).toMatchObject(expected);
    expect(onlyUser([...merged, [12, userState("u-a", "Ann 更舊", { field: false })]])).toMatchObject(expected);
  });

  it("equal or missing since: when neither has it the larger clientID wins; since=0 beats missing (-infinity)", () => {
    expect(
      onlyUser([
        [31, userState("u-a", "大", { role: "editor" })],
        [30, userState("u-a", "小", { role: "editor" })],
      ]).name,
    ).toBe("大");
    expect(
      onlyUser([
        [30, userState("u-a", "有 since", { since: 0 })],
        [31, userState("u-a", "沒有 since")],
      ]).name,
    ).toBe("有 since");
  });

  it("with or without cursor: any one having it counts as having", () => {
    expect(
      onlyUser([
        [10, userState("u-a", "Ann", { cursor: { anchor: {}, head: {} } })],
        [11, userState("u-a", "Ann", { cursor: null })],
      ]).hasCursor,
    ).toBe(true);
    expect(
      onlyUser([
        [10, userState("u-a", "Ann")],
        [11, userState("u-a", "Ann")],
      ]).hasCursor,
    ).toBe(false);
  });

  it("AI does not merge: one entry per clientID, color AGENT_PRESENCE_COLOR", () => {
    const list = people([
      [20, agentState("bob", "Claude", { color: "#000000" })],
      [21, agentState("bob", "Cursor", { color: "#000000" })],
    ]);
    expect(list.map((p) => p.key)).toEqual(["agent:20", "agent:21"]);
    expect(list.map((p) => p.color)).toEqual([AGENT_PRESENCE_COLOR, AGENT_PRESENCE_COLOR]);
    expect(list[0]).toMatchObject({ kind: "agent", clientId: 20, handle: "bob", label: "Claude" });
  });

  it("a non-object, no user, or an empty or non-string user.id is skipped", () => {
    expect(
      people([
        [10, null],
        [11, "x"],
        [12, {}],
        [13, { user: {} }],
        [14, { user: { id: "" } }],
        [15, { user: { id: 5 } }],
      ]),
    ).toEqual([]);
  });

  it("old-version client: only user gives no role, no avatar, cursor as is", () => {
    expect(onlyUser([[10, { user: { id: "u-a", name: "Ann" }, cursor: CURSOR }]])).toMatchObject({
      name: "Ann",
      role: null,
      avatar: null,
      hasCursor: true,
    });
  });

  it("a malicious avatar gives null; a valid one gives { id, v }", () => {
    for (const avatar of ["https://evil/x.png", "javascript:alert(1)", { id: "../x", v: 1 }, { id: UUID, v: 1e300 }]) {
      expect(onlyUser([[10, userState("u-a", "Ann", { avatar })]]).avatar).toBeNull();
    }
    expect(onlyUser([[10, userState("u-a", "Ann", { avatar: { id: UUID, v: 3 } })]]).avatar).toEqual({ id: UUID, v: 3 });
  });

  it("knotebook.v === 2: the whole field counts as absent", () => {
    const state = { user: { id: "u-a", name: "Ann" }, knotebook: { v: 2, kind: "user", role: "owner", avatar: null, since: 1 } };
    expect(onlyUser([[10, state]]).role).toBeNull();
  });

  it("a role not in the allow list gives null", () => {
    expect(onlyUser([[10, userState("u-a", "Ann", { role: "admin" })]]).role).toBeNull();
  });

  it("a kind that is not user/agent: neither role nor avatar is used", () => {
    const state = {
      user: { id: "u-a", name: "Ann" },
      knotebook: { v: 1, kind: "bogus", role: "owner", avatar: { id: UUID, v: 1 }, since: 9 },
    };
    expect(onlyUser([[10, state]])).toMatchObject({ role: null, avatar: null });
  });

  it("kind: agent but missing label or handle: does not appear", () => {
    expect(people([[20, { user: { name: "x" }, knotebook: { v: 1, kind: "agent", handle: "bob" } }]])).toEqual([]);
    expect(people([[21, { user: { name: "x" }, knotebook: { v: 1, kind: "agent", label: "Claude" } }]])).toEqual([]);
  });

  it("a person's color = collabUserColor(userId), state.user.color is not read", () => {
    expect(onlyUser([[10, userState("u-a", "Ann", { color: "#ff0000" })]]).color).toBe(collabUserColor("u-a"));
  });
});

describe("presenceCursor", () => {
  it("picks the one with a cursor and the largest since; for AI picks that clientID; a missing one gives null", () => {
    const c10 = { anchor: { c: 10 }, head: { c: 10 } };
    const c11 = { anchor: { c: 11 }, head: { c: 11 } };
    const one = new Map<number, unknown>([
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200 })],
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100, cursor: c11 })],
    ]);
    expect(presenceCursor(one, "user:u-a", MY_CLIENT, ME)).toBe(c11);
    const both = new Map<number, unknown>([
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100, cursor: c11 })],
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200, cursor: c10 })],
    ]);
    expect(presenceCursor(both, "user:u-a", MY_CLIENT, ME)).toBe(c10);
    const ai = { anchor: { ai: 1 }, head: { ai: 1 } };
    const withAi = new Map<number, unknown>([[20, agentState("bob", "Claude", { cursor: ai })]]);
    expect(presenceCursor(withAi, "agent:20", MY_CLIENT, ME)).toBe(ai);
    expect(presenceCursor(both, "user:u-x", MY_CLIENT, ME)).toBeNull();
  });
});

function user(id: string): PresencePerson {
  return { kind: "user", key: `user:${id}`, userId: id, name: id, role: null, avatar: null, color: "c", hasCursor: false };
}

describe("orderBySeen", () => {
  it("in order of arrival; removed on leaving; coming back goes last", () => {
    const [a, b, c] = [user("a"), user("b"), user("c")];
    let r = orderBySeen(new Map(), [b, a], 0);
    expect(r.people.map((p) => p.key)).toEqual(["user:b", "user:a"]);
    r = orderBySeen(r.seen, [a, b, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:b", "user:a", "user:c"]);
    r = orderBySeen(r.seen, [a, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:a", "user:c"]);
    r = orderBySeen(r.seen, [a, b, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:a", "user:c", "user:b"]);
  });
});

describe("presenceSignature", () => {
  it("cursor position does not count; having a cursor, name, role, avatar v and headcount do", () => {
    const sig = (entries: [number, unknown][]) => presenceSignature(people(entries));
    const base = sig([[10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]]);
    expect(
      sig([[10, userState("u-a", "Ann", { role: "editor", cursor: { anchor: { x: 9 }, head: { x: 9 } }, avatar: { id: UUID, v: 1 } })]]),
    ).toBe(base);
    const variants: [number, unknown][][] = [
      [[10, userState("u-a", "Ann", { role: "editor", cursor: null, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann L", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann", { role: "viewer", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 2 } })]],
      [
        [10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })],
        [11, userState("u-b", "Bob")],
      ],
    ];
    for (const v of variants) expect(sig(v)).not.toBe(base);
  });
});

describe("presenceLayout", () => {
  it.each([
    [0, 0, 0, 0, 0, 0],
    [1, 1, 0, 1, 0, 1],
    [2, 2, 0, 2, 0, 2],
    [3, 3, 0, 1, 2, 3],
    [5, 5, 0, 1, 4, 5],
    [6, 4, 2, 1, 5, 6],
    [9, 4, 5, 1, 8, 9],
  ])("total=%i -> wide %i/%i, narrow %i/%i, compact 0/%i", (total, ws, wm, ns, nm, cm) => {
    expect(presenceLayout(total)).toEqual({
      wide: { shown: ws, more: wm },
      narrow: { shown: ns, more: nm },
      compact: { shown: 0, more: cm },
    });
  });
});

describe("firstGrapheme", () => {
  it("people still re-exports the same firstGrapheme / hasVisibleText as lib", () => {
    expect(firstGrapheme).toBe(libFirstGrapheme);
    expect(hasVisibleText).toBe(libHasVisibleText);
  });
});
