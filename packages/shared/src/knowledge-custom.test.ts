import { describe, expect, it } from "vitest";
import {
  formatKnowledgeCustom,
  knowledgeMemberIdsIn,
  knowledgeMemberToken,
  knowledgeMemberTokensIn,
  parseKnowledgeCustom,
  safeKnowledgeHref,
} from "./knowledge-custom.js";
import { resolveKnowledgeFieldView, type KnowledgeFieldDefRow, type KnowledgeFieldOverrideRow } from "./knowledge-fields.js";
import type { KnowledgeInfo } from "./knowledge.js";

const field = (key: string, type: KnowledgeFieldDefRow["type"], createdAt: string): KnowledgeFieldDefRow => ({ kind: "field", fieldRef: `x-${key}`, key, type, createdAt });
const off = (key: string): KnowledgeFieldOverrideRow => ({ fieldRef: `x-${key}`, optionKey: "", enabled: false, name: null, position: null });
const view = resolveKnowledgeFieldView({
  defs: [field("owner", "member", "2026-01-01"), field("team", "text", "2026-01-02"), field("reviewer", "member", "2026-01-03")],
  site: [off("reviewer")],
});
const info = (custom: Record<string, string>): KnowledgeInfo => ({ id: "k_00000001", when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", custom });

describe("parseKnowledgeCustom", () => {
  it.each([
    ["not json", {}],
    ["[1,2]", {}],
    ['{"a":1,"Bad":"x","ok":"v","b":["x"]}', { ok: "v" }],
    [42, {}],
    [["x"], {}],
    ['"text"', {}],
    ["null", {}],
    [undefined, {}],
    ['{"ok":"v"}', { ok: "v" }],
  ])("parseKnowledgeCustom(%j) skips what isn't a key to string", (raw, out) => expect(parseKnowledgeCustom(raw)).toEqual(out));

  it("drops empty values and keys that are not field keys", () => {
    expect(parseKnowledgeCustom('{"a":"","-b":"x","é":"x","c":"y","d\\n":"z"}')).toEqual({ c: "y" });
  });

  it("a key that names an Object prototype member reads as its own value only", () => {
    const parsed = parseKnowledgeCustom('{"other":"x"}');
    expect(Object.hasOwn(parsed, "constructor")).toBe(false);
    expect(parseKnowledgeCustom('{"constructor":"v"}')).toEqual({ constructor: "v" });
  });
});

describe("formatKnowledgeCustom", () => {
  it("formatKnowledgeCustom sorts keys, drops empty values and is empty when nothing is left", () => {
    expect(formatKnowledgeCustom({ b: "2", a: "1", c: "" })).toBe('{"a":"1","b":"2"}');
    expect(formatKnowledgeCustom({ a: "" })).toBe("");
    expect(formatKnowledgeCustom({})).toBe("");
  });

  it("round-trips through parseKnowledgeCustom", () => {
    const values = { team: 'a "quoted" \\ value', owner: "u-1", z: "測試😀" };
    expect(parseKnowledgeCustom(formatKnowledgeCustom(values))).toEqual(values);
  });
});

describe("safeKnowledgeHref", () => {
  it.each([
    ["https://example.com/a", true],
    ["http://example.com", true],
    ["HTTPS://example.com/a?b=c#d", true],
    ["/n/alice/x", true],
    ["/", true],
    ["//evil.example", false],
    ["/\\evil.example", false],
    ["javascript:alert(1)", false],
    ["mailto:a@b", false],
    ["data:text/html,x", false],
    [" https://x", false],
    ["https://x y", false],
    ["https://x\n", false],
    ["relative/path", false],
    ["", false],
  ])("safeKnowledgeHref(%j) allowed=%s", (v, ok) => expect(safeKnowledgeHref(v) !== null).toBe(ok));

  it("returns the value as written", () => {
    expect(safeKnowledgeHref("HTTPS://Example.com/A")).toBe("HTTPS://Example.com/A");
  });
});

describe("member helpers", () => {
  it("a member is written by handle, else as user:<id>", () => {
    const handleOf = new Map([["u-1", "bob"]]);
    expect(knowledgeMemberToken("u-1", handleOf)).toBe("bob");
    expect(knowledgeMemberToken("u-2", handleOf)).toBe("user:u-2");
  });

  it("collects the lowercased tokens written in turned-on member fields of knowledge headings", () => {
    const blocks = [
      { type: "heading", props: { knowledgeId: "k_00000001", knowledgeCustom: JSON.stringify({ owner: "Bob", team: "alice", reviewer: "carol" }) } },
      { type: "heading", props: { knowledgeId: "k_00000002", knowledgeCustom: JSON.stringify({ owner: "user:U-9" }) } },
      { type: "heading", props: { knowledgeId: "k_00000003", knowledgeCustom: JSON.stringify({ owner: "bob" }) } },
      { type: "heading", props: { knowledgeId: "", knowledgeCustom: JSON.stringify({ owner: "dave" }) } },
      { type: "paragraph", props: { knowledgeId: "k_00000004", knowledgeCustom: JSON.stringify({ owner: "erin" }) } },
      { type: "heading", props: { knowledgeId: "k_00000005", knowledgeCustom: "not json" } },
    ];
    expect(knowledgeMemberTokensIn(blocks, view)).toEqual(["bob", "user:u-9"]);
  });

  it("collects stored member ids of turned-on member fields once each", () => {
    expect(knowledgeMemberIdsIn([info({ owner: "u-1", team: "u-2", reviewer: "u-3" }), info({ owner: "u-1" }), info({ owner: "u-4" })], view)).toEqual(["u-1", "u-4"]);
  });
});
