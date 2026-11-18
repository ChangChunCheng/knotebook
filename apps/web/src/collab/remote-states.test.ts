import { describe, expect, it } from "vitest";
import { collabUserColor } from "@knotebook/shared";
import { hslToHex, safeCursorColor, sanitizeRemoteStates } from "./remote-states";

describe("hslToHex", () => {
  it("把 collabUserColor 的 hsl 轉成 #rrggbb", () => {
    expect(hslToHex("hsl(0 65% 45%)")).toBe("#bd2828");
    expect(hslToHex("hsl(120 65% 45%)")).toBe("#28bd28");
    expect(hslToHex("hsl(240 65% 45%)")).toBe("#2828bd");
  });
  it("不是 hsl 形就回 null", () => {
    expect(hslToHex("#ff0000")).toBeNull();
  });
});

describe("safeCursorColor", () => {
  it("有 id：一律用 id 算出的顏色（#rrggbb），送來的顏色不採信", () => {
    const c = safeCursorColor({ id: "u2", color: "red;background-image:url(https://example.invalid/a)" });
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(c).toBe(hslToHex(collabUserColor("u2")));
  });
  it("沒有 id：合法的 #rrggbb 保留（AI 代理的顏色）", () => {
    expect(safeCursorColor({ color: "#7c3aed" })).toBe("#7c3aed");
  });
  it("其他一律退回灰色", () => {
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

  it("畸形的 cursor 變 null，合法的原樣保留", () => {
    const out = sanitizeRemoteStates(
      new Map<number, unknown>([
        [1, { user: { id: "a", name: "A" }, cursor: {} }],
        [2, { user: { id: "b", name: "B" }, cursor }],
      ]),
    );
    expect(out.get(1)?.cursor).toBeNull();
    expect(out.get(2)?.cursor).toEqual(cursor);
  });

  it("丟掉不是物件的狀態；其他欄位保留；user 只剩 id、name、color", () => {
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

  it("同一個輸入物件，重複呼叫回同一個輸出物件", () => {
    const state = { user: { id: "a", name: "A" }, cursor: null };
    const first = sanitizeRemoteStates(new Map<number, unknown>([[1, state]])).get(1);
    const second = sanitizeRemoteStates(new Map<number, unknown>([[1, state]])).get(1);
    expect(second).toBe(first);
  });
});
