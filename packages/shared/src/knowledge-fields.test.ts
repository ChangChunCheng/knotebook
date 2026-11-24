import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BUILTIN_EVIDENCE } from "./knowledge.js";
import {
  DEFAULT_KNOWLEDGE_FIELD_VIEW,
  KNOWLEDGE_KEY_RE,
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  isKnowledgeFieldEnabled,
  knowledgeField,
  knowledgeKeyFromName,
  knowledgeOption,
  resolveKnowledgeFieldView,
  type KnowledgeFieldDefRow,
  type KnowledgeFieldOverrideRow,
} from "./knowledge-fields.js";

const override = (over: Partial<KnowledgeFieldOverrideRow> & Pick<KnowledgeFieldOverrideRow, "fieldRef">): KnowledgeFieldOverrideRow => ({
  optionKey: "", enabled: null, name: null, position: null, ...over,
});

describe("resolveKnowledgeFieldView", () => {
  it("no rows resolve to the default view", () => {
    expect(resolveKnowledgeFieldView({ defs: [], site: [] })).toEqual(DEFAULT_KNOWLEDGE_FIELD_VIEW);
    expect(DEFAULT_KNOWLEDGE_FIELD_VIEW.fields.map((f) => [f.key, f.type, f.enabled])).toEqual([
      ["when", "text", true], ["conclusion", "text", true], ["evidence", "select", true], ["verified", "date", true], ["superseded_by", "ref", true],
    ]);
    expect(knowledgeField(DEFAULT_KNOWLEDGE_FIELD_VIEW, "evidence")!.options!.map((o) => o.key)).toEqual(["tested", "docs", "inferred"]);
    expect(knowledgeField(DEFAULT_KNOWLEDGE_FIELD_VIEW, "evidence")!.options!.map((o) => o.key)).toEqual([...KNOWLEDGE_BUILTIN_EVIDENCE]);
    expect(DEFAULT_KNOWLEDGE_FIELD_VIEW.fields.every((f) => f.builtin && f.name === null)).toBe(true);
  });

  it("the shared default view cannot be changed by a caller, at any depth", () => {
    const view = DEFAULT_KNOWLEDGE_FIELD_VIEW as { fields: Array<{ enabled: boolean; options?: Array<{ name: string | null }> }> };
    const evidence = view.fields[2]!;
    expect(() => view.fields.push(evidence)).toThrow(TypeError);
    expect(() => { evidence.enabled = false; }).toThrow(TypeError);
    expect(() => evidence.options!.pop()).toThrow(TypeError);
    expect(() => { evidence.options![0]!.name = "Changed"; }).toThrow(TypeError);
    expect(() => { (view as { fields: unknown }).fields = []; }).toThrow(TypeError);
    expect(resolveKnowledgeFieldView({ defs: [], site: [] })).toEqual(DEFAULT_KNOWLEDGE_FIELD_VIEW);
    expect(Object.isFrozen(resolveKnowledgeFieldView({ defs: [], site: [] }))).toBe(false);
  });

  it("a group inherits what the site changes later unless it overrode that item", () => {
    const defs = [{ kind: "option", fieldRef: "evidence", key: "vendor-doc", type: null, createdAt: "2026-01-01T00:00:00Z" }] as const;
    const site = [
      { fieldRef: "evidence", optionKey: "docs", enabled: null, name: "Spec", position: null },
      { fieldRef: "when", optionKey: "", enabled: false, name: null, position: null },
    ] as const;
    const group = [
      { fieldRef: "evidence", optionKey: "tested", enabled: null, name: "Measured", position: null },
      { fieldRef: "when", optionKey: "", enabled: null, name: null, position: null },
    ] as const;
    const view = resolveKnowledgeFieldView({ defs, site, group });
    expect(knowledgeField(view, "evidence")!.options!.map((o) => [o.key, o.name])).toEqual([
      ["tested", "Measured"], ["docs", "Spec"], ["inferred", null], ["vendor-doc", null],
    ]);
    expect(isKnowledgeFieldEnabled(view, "when")).toBe(false);
    expect(knowledgeOption(view, "evidence", "vendor-doc")).toEqual({ key: "vendor-doc", name: null, enabled: true, builtin: false });
  });

  it("a group value wins over the site value for the same item", () => {
    const view = resolveKnowledgeFieldView({
      defs: [],
      site: [override({ fieldRef: "evidence", optionKey: "docs", enabled: false })],
      group: [override({ fieldRef: "evidence", optionKey: "docs", enabled: true }), override({ fieldRef: "verified", enabled: false })],
    });
    expect(knowledgeOption(view, "evidence", "docs")!.enabled).toBe(true);
    expect(isKnowledgeFieldEnabled(view, "verified")).toBe(false);
  });

  it("builtin fields keep their order whatever position they are given", () => {
    const view = resolveKnowledgeFieldView({ defs: [], site: [override({ fieldRef: "superseded_by", position: 0 }), override({ fieldRef: "when", position: 9 })] });
    expect(view.fields.map((f) => f.key)).toEqual(["when", "conclusion", "evidence", "verified", "superseded_by"]);
  });

  it("custom fields follow position, then creation time", () => {
    const defs: KnowledgeFieldDefRow[] = [
      { kind: "field", fieldRef: "x-a", key: "a", type: "text", createdAt: "2026-01-01T00:00:00Z" },
      { kind: "field", fieldRef: "x-b", key: "b", type: "select", createdAt: "2026-01-02T00:00:00Z" },
      { kind: "field", fieldRef: "x-c", key: "c", type: "date", createdAt: "2026-01-03T00:00:00Z" },
      { kind: "field", fieldRef: "x-d", key: "d", type: "link", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const site = [override({ fieldRef: "x-a", position: 1 }), override({ fieldRef: "x-b", position: 0, name: "Team" })];
    const view = resolveKnowledgeFieldView({ defs, site });
    expect(view.fields.map((f) => f.key)).toEqual(["when", "conclusion", "evidence", "verified", "superseded_by", "x-b", "x-a", "x-d", "x-c"]);
    expect(knowledgeField(view, "x-b")).toEqual({ key: "x-b", builtin: false, type: "select", name: "Team", enabled: true, options: [] });
    expect(knowledgeField(view, "x-a")!.options).toBeUndefined();
  });

  it("options of a custom single choice field are its own and sorted like builtin options", () => {
    const defs: KnowledgeFieldDefRow[] = [
      { kind: "field", fieldRef: "x-team", key: "team", type: "select", createdAt: "2026-01-01T00:00:00Z" },
      { kind: "option", fieldRef: "x-team", key: "core", type: null, createdAt: "2026-01-02T00:00:00Z" },
      { kind: "option", fieldRef: "x-team", key: "web", type: null, createdAt: "2026-01-03T00:00:00Z" },
      { kind: "option", fieldRef: "evidence", key: "survey", type: null, createdAt: "2026-01-02T00:00:00Z" },
    ];
    const view = resolveKnowledgeFieldView({
      defs,
      site: [override({ fieldRef: "x-team", optionKey: "web", position: 0 }), override({ fieldRef: "evidence", optionKey: "survey", position: 0 })],
    });
    expect(knowledgeField(view, "x-team")!.options!.map((o) => o.key)).toEqual(["web", "core"]);
    expect(knowledgeField(view, "evidence")!.options!.map((o) => o.key)).toEqual(["tested", "survey", "docs", "inferred"]);
  });

  it("an unknown field is not enabled and has no options", () => {
    expect(isKnowledgeFieldEnabled(DEFAULT_KNOWLEDGE_FIELD_VIEW, "x-missing")).toBe(false);
    expect(knowledgeOption(DEFAULT_KNOWLEDGE_FIELD_VIEW, "x-missing", "a")).toBeUndefined();
    expect(knowledgeOption(DEFAULT_KNOWLEDGE_FIELD_VIEW, "evidence", "missing")).toBeUndefined();
  });
});

describe("knowledge keys", () => {
  it("the reserved basis keys are the builtin options and unconfirmed", () => {
    expect([...KNOWLEDGE_RESERVED_EVIDENCE_KEYS]).toEqual([...KNOWLEDGE_BUILTIN_EVIDENCE, "unconfirmed"]);
  });

  it.each([
    ["Owner Team", new Set<string>(), "owner-team"],
    ["--A--", new Set<string>(), "a"],
    ["tested", new Set(["tested"]), "tested-2"],
    ["tested", new Set(["tested", "tested-2"]), "tested-3"],
    ["Café Ｎｏｔｅ", new Set<string>(), "cafe-note"],
  ])("knowledgeKeyFromName(%s) is %s", (name, taken, key) => expect(knowledgeKeyFromName(name, taken)).toBe(key));

  it("a long name that collides still yields a key within 64 characters", () => {
    const long = "a".repeat(80);
    expect(knowledgeKeyFromName(long, new Set())).toBe("a".repeat(64));
    expect(knowledgeKeyFromName(long, new Set(["a".repeat(64)]))).toBe(`${"a".repeat(62)}-2`);
  });

  it("a name with no ASCII letters gets a random key that still matches the key format", () => {
    expect(knowledgeKeyFromName("負責人", new Set())).toMatch(KNOWLEDGE_KEY_RE);
    expect(knowledgeKeyFromName("!!!", new Set())).toMatch(/^k[0-9a-z]{5}$/);
  });

  it("the key format", () => {
    for (const good of ["a", "0", "vendor-doc", "a-", "a".repeat(64)]) expect(KNOWLEDGE_KEY_RE.test(good), good).toBe(true);
    for (const bad of ["", "-a", "A", "a_b", "abé", "a".repeat(65), "ab\n"]) expect(KNOWLEDGE_KEY_RE.test(bad), JSON.stringify(bad)).toBe(false);
  });
});
