import { describe, expect, it } from "vitest";
import { collabUserColor } from "@knotebook/shared";
import { hslToHex, safeCursorColor, sanitizeRemoteStates } from "./remote-states";

describe("hslToHex", () => {
  it("converts the hsl from collabUserColor to #rrggbb", () => {
    expect(hslToHex("hsl(0 65% 45%)")).toBe("#bd2828");
    expect(hslToHex("hsl(120 65% 45%)")).toBe("#28bd28");
    expect(hslToHex("hsl(240 65% 45%)")).toBe("#2828bd");
  });
  it("returns null when it isn't hsl-shaped", () => {
    expect(hslToHex("#ff0000")).toBeNull();
  });
});

describe("safeCursorColor", () => {
  it("with an id: the color derived from the id (#rrggbb) is used and the color sent is not trusted", () => {
    const c = safeCursorColor({ id: "u2", color: "red;background-image:url(https://example.invalid/a)" });
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(c).toBe(hslToHex(collabUserColor("u2")));
  });
  it("without an id: a valid #rrggbb is kept (an AI agent's color)", () => {
    expect(safeCursorColor({ color: "#7c3aed" })).toBe("#7c3aed");
  });
  it("anything else falls back to gray", () => {
    expect(safeCursorColor({ color: "hsl(1 2% 3%);x" })).toBe("#888888");
    expect(safeCursorColor({ color: "x" })).toBe("#888888");
    expect(safeCursorColor(null)).toBe("#888888");
  });
});

describe("sanitizeRemoteStates", () => {
  const cursor = {
    anchor: { type: { client: 1, clock: 2 }, assoc: 0 },
    head: { type: { client: 1, clock: 2 }, assoc: 0 },
  };

  it("a malformed cursor becomes null, a valid one is kept as is", () => {
    const out = sanitizeRemoteStates(
      new Map<number, unknown>([
        [1, { user: { id: "a", name: "A" }, cursor: {} }],
        [2, { user: { id: "b", name: "B" }, cursor }],
      ]),
    );
    expect(out.get(1)?.cursor).toBeNull();
    expect(out.get(2)?.cursor).toEqual(cursor);
  });

  it("the shape y-prosemirror really sends (unused fields are null) -> accepted and normalized", () => {
    const wire = { type: null, tname: "knotebook", item: null, assoc: 0 };
    const out = sanitizeRemoteStates(new Map<number, unknown>([[1, { user: { id: "a", name: "A" }, cursor: { anchor: wire, head: wire } }]]));
    const norm = { tname: "knotebook", assoc: 0 };
    expect(out.get(1)?.cursor).toEqual({ anchor: norm, head: norm });
  });

  it("states that aren't objects are dropped; other fields are kept; user is reduced to id, name, color", () => {
    const out = sanitizeRemoteStates(
      new Map<number, unknown>([
        [1, null],
        [2, "x"],
        [3, { user: { id: "a", name: 5, color: "red", extra: 1 }, knotebook: { v: 1 }, other: true }],
      ]),
    );
    expect([...out.keys()]).toEqual([3]);
    const s = out.get(3)!;
    expect(s.knotebook).toEqual({ v: 1 });
    expect(s.other).toBe(true);
    expect(s.user).toEqual({ id: "a", name: "", color: hslToHex(collabUserColor("a")) });
  });

  it("the same input object gives the same output object on repeated calls", () => {
    const state = { user: { id: "a", name: "A" }, cursor: null };
    const first = sanitizeRemoteStates(new Map<number, unknown>([[1, state]])).get(1);
    const second = sanitizeRemoteStates(new Map<number, unknown>([[1, state]])).get(1);
    expect(second).toBe(first);
  });
});
