import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { AGENT_PRESENCE_COLOR, PRESENCE_FIELD, collabUserColor, parseAwarenessCursor } from "./presence.js";
import { YDOC_FRAGMENT } from "./ydoc.js";

describe("collabUserColor（搬家後輸出不變）", () => {
  it.each([
    ["", "hsl(0 65% 45%)"],
    ["a", "hsl(97 65% 45%)"],
    ["user-1", "hsl(31 65% 45%)"],
    ["00000000-0000-4000-8000-000000000001", "hsl(29 65% 45%)"],
    ["王小明", "hsl(162 65% 45%)"],
    ["x".repeat(200), "hsl(40 65% 45%)"],
  ])("%j → %s", (seed, expected) => {
    expect(collabUserColor(seed)).toBe(expected);
    expect(collabUserColor(seed)).toMatch(/^hsl\(\d{1,3} 65% 45%\)$/);
  });
});

describe("常數", () => {
  it("AGENT_PRESENCE_COLOR 與 PRESENCE_FIELD", () => {
    expect(AGENT_PRESENCE_COLOR).toBe("#7c3aed");
    expect(PRESENCE_FIELD).toBe("knotebook");
  });
});

describe("parseAwarenessCursor", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText("hello");
  paragraph.insert(0, [text]);
  fragment.insert(0, [paragraph]);
  const json = (rel: Y.RelativePosition): Record<string, unknown> =>
    Y.relativePositionToJSON(rel) as Record<string, unknown>;
  const p = json(Y.createRelativePositionFromTypeIndex(text, 2));

  it("item 為基礎的位置原樣通過", () => {
    expect(parseAwarenessCursor({ anchor: p, head: p })).toEqual({ anchor: p, head: p });
  });

  it.each([
    ["非根型別的結尾（type）", () => json(Y.createRelativePositionFromTypeIndex(text, text.length))],
    ["根 fragment 的結尾（tname）", () => json(Y.createRelativePositionFromTypeIndex(fragment, fragment.length))],
    ["assoc -1", () => json(Y.createRelativePositionFromTypeIndex(text, 0, -1))],
  ])("%s 來回不變", (_name, make) => {
    const pos = make();
    expect(parseAwarenessCursor({ anchor: pos, head: pos })).toEqual({ anchor: pos, head: pos });
  });

  it("多餘的 key 全部丟掉", () => {
    expect(parseAwarenessCursor({ anchor: { ...p, x: 1 }, head: p, extra: "y" })).toEqual({ anchor: p, head: p });
    const withItem = { anchor: { ...p, item: { ...(p.item as object), z: 1 } }, head: p };
    expect(parseAwarenessCursor(withItem)).toEqual({ anchor: p, head: p });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["數字", 1],
    ["字串", "x"],
    ["陣列", []],
    ["空物件", {}],
    ["缺 head", { anchor: p }],
    ["anchor/head 為 null", { anchor: null, head: null }],
    ["type 與 tname 並存", { anchor: { ...p, type: { client: 1, clock: 0 }, tname: YDOC_FRAGMENT }, head: p }],
    ["type 與 tname 皆無", { anchor: { item: { client: 1, clock: 0 } }, head: p }],
    ["tname 不符", { anchor: { tname: "other" }, head: p }],
    ["client 為負", { anchor: { type: { client: -1, clock: 0 } }, head: p }],
    ["client 超過 32 位元", { anchor: { type: { client: 2 ** 32, clock: 0 } }, head: p }],
    ["clock 非整數", { anchor: { type: { client: 1, clock: 1.5 } }, head: p }],
    ["clock 為字串", { anchor: { type: { client: 1, clock: "3" } }, head: p }],
    ["assoc 非整數", { anchor: { ...p, assoc: 0.5 }, head: p }],
    ["item 為陣列", { anchor: { type: { client: 1, clock: 0 }, item: [1, 2] }, head: p }],
  ])("%s → null", (_name, input) => {
    expect(parseAwarenessCursor(input)).toBeNull();
  });
});
