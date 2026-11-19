import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { AGENT_PRESENCE_COLOR, PRESENCE_FIELD, collabUserColor, parseAwarenessCursor } from "./presence.js";
import { YDOC_FRAGMENT } from "./ydoc.js";

describe("collabUserColor (output unchanged after the move)", () => {
  it.each([
    ["", "hsl(0 65% 45%)"],
    ["a", "hsl(97 65% 45%)"],
    ["user-1", "hsl(31 65% 45%)"],
    ["00000000-0000-4000-8000-000000000001", "hsl(29 65% 45%)"],
    ["王小明", "hsl(162 65% 45%)"],
    ["x".repeat(200), "hsl(40 65% 45%)"],
  ])("%j -> %s", (seed, expected) => {
    expect(collabUserColor(seed)).toBe(expected);
    expect(collabUserColor(seed)).toMatch(/^hsl\(\d{1,3} 65% 45%\)$/);
  });
});

describe("constants", () => {
  it("AGENT_PRESENCE_COLOR and PRESENCE_FIELD", () => {
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

  it("an item-based position passes through as is", () => {
    expect(parseAwarenessCursor({ anchor: p, head: p })).toEqual({ anchor: p, head: p });
  });

  it.each([
    ["end of a non-root type (type)", () => json(Y.createRelativePositionFromTypeIndex(text, text.length))],
    ["end of the root fragment (tname)", () => json(Y.createRelativePositionFromTypeIndex(fragment, fragment.length))],
    ["assoc -1", () => json(Y.createRelativePositionFromTypeIndex(text, 0, -1))],
  ])("%s round-trips unchanged", (_name, make) => {
    const pos = make();
    expect(parseAwarenessCursor({ anchor: pos, head: pos })).toEqual({ anchor: pos, head: pos });
  });

  it("realistic shapes (unused fields are null): item, end of a non-root type (item null), assoc -1, start and end of the root fragment all pass and are normalised", () => {
    const wire = (rel: Y.RelativePosition): unknown => JSON.parse(JSON.stringify(rel));
    for (const rel of [
      Y.createRelativePositionFromTypeIndex(text, 2),
      Y.createRelativePositionFromTypeIndex(text, text.length),
      Y.createRelativePositionFromTypeIndex(text, 0, -1),
      Y.createRelativePositionFromTypeIndex(fragment, 0),
      Y.createRelativePositionFromTypeIndex(fragment, fragment.length),
    ]) {
      const expected = json(rel);
      expect(parseAwarenessCursor({ anchor: wire(rel), head: wire(rel) })).toEqual({ anchor: expected, head: expected });
    }
  });

  it("type, tname and item all null -> rejected", () => {
    const empty = { type: null, tname: null, item: null, assoc: 0 };
    expect(parseAwarenessCursor({ anchor: empty, head: empty })).toBeNull();
  });

  it("extra keys are all dropped", () => {
    expect(parseAwarenessCursor({ anchor: { ...p, x: 1 }, head: p, extra: "y" })).toEqual({ anchor: p, head: p });
    const withItem = { anchor: { ...p, item: { ...(p.item as object), z: 1 } }, head: p };
    expect(parseAwarenessCursor(withItem)).toEqual({ anchor: p, head: p });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 1],
    ["string", "x"],
    ["array", []],
    ["empty object", {}],
    ["missing head", { anchor: p }],
    ["anchor/head are null", { anchor: null, head: null }],
    ["type and tname both present", { anchor: { ...p, type: { client: 1, clock: 0 }, tname: YDOC_FRAGMENT }, head: p }],
    ["neither type nor tname", { anchor: { item: { client: 1, clock: 0 } }, head: p }],
    ["tname mismatch", { anchor: { tname: "other" }, head: p }],
    ["negative client", { anchor: { type: { client: -1, clock: 0 } }, head: p }],
    ["client over 32 bits", { anchor: { type: { client: 2 ** 32, clock: 0 } }, head: p }],
    ["clock is not an integer", { anchor: { type: { client: 1, clock: 1.5 } }, head: p }],
    ["clock is a string", { anchor: { type: { client: 1, clock: "3" } }, head: p }],
    ["assoc is not an integer", { anchor: { ...p, assoc: 0.5 }, head: p }],
    ["item is an array", { anchor: { type: { client: 1, clock: 0 }, item: [1, 2] }, head: p }],
  ])("%s -> null", (_name, input) => {
    expect(parseAwarenessCursor(input)).toBeNull();
  });
});
