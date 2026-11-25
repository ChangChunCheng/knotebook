import { describe, expect, it } from "vitest";
import type { KnowledgeInfo } from "./knowledge.js";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, resolveKnowledgeFieldView, type KnowledgeBuiltinFieldKey, type KnowledgeFieldView } from "./knowledge-fields.js";
import {
  decodeKnowledgeValue,
  encodeKnowledgeValue,
  formatKnowledgeComment,
  isKnowledgeCommentData,
  parseKnowledgeComment,
} from "./knowledge-markdown.js";

const TRICKY = [
  "a --> b", "a --!> b", "--", "x\ny", "x\r\ny", " lead", "trail ", "\tt", "\u00a0nbsp", '"quoted" start',
  "C:\\Users\\alice", "key: value: more", "中文 與 emoji 😀", "a\u2028b", "a\u0085b", "<!-- inner", ">", "a -> b", "",
  "a\u2029b", "del\u007fchar", "back\\slash\\n", "pipe | here", "a\u0000b", "lone \ud800 high", "lone \udc00 low", "-", "a-", "--!", "a|b\tc",
];

// Fixed seed so a failure is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL = [
  ...TRICKY.join("").split(""),
  ..."abcXYZ019 :-<>!\"\\|\t\n\r".split(""),
  ...("測試知識結論😀".match(/./gu) ?? []),
  ..."\u0000\u0001\u001f\u007f\u0080\u009f\u2028\u2029".split(""),
];
function generated(count: number, seed: number): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const len = Math.floor(rnd() * 41);
    let s = "";
    for (let j = 0; j < len; j += 1) s += POOL[Math.floor(rnd() * POOL.length)]!;
    out.push(s);
  }
  return out;
}
const GENERATED = generated(2000, 20261121);

const info = (over: Partial<KnowledgeInfo> = {}): KnowledgeInfo => ({
  id: "k_8f3a2c1d", when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", custom: {}, ...over,
});
const customView = resolveKnowledgeFieldView({
  defs: [
    { kind: "field", fieldRef: "x-owner", key: "owner", type: "member", createdAt: "2026-01-02" },
    { kind: "field", fieldRef: "x-team", key: "team", type: "text", createdAt: "2026-01-01" },
    { kind: "field", fieldRef: "x-old", key: "old", type: "text", createdAt: "2026-01-03" },
  ],
  site: [{ fieldRef: "x-old", optionKey: "", enabled: false, name: null, position: null }],
});
const viewWith = (enabled: Partial<Record<KnowledgeBuiltinFieldKey, boolean>>): KnowledgeFieldView =>
  resolveKnowledgeFieldView({ defs: [], site: Object.entries(enabled).map(([fieldRef, on]) => ({ fieldRef: fieldRef as KnowledgeBuiltinFieldKey, optionKey: "", enabled: on, name: null, position: null })) });
// The text between `<!--` and `-->`, as a Comment node's data.
const dataOf = (comment: string): string => comment.slice("<!--".length, -"-->".length);

// Parsing rejects these as unstorable, by design.
const storable = (v: string): boolean => !v.includes("\u0000") && !/\p{Surrogate}/u.test(v);

describe("encodeKnowledgeValue / decodeKnowledgeValue", () => {
  it("round-trips every tricky value", () => {
    for (const v of TRICKY) expect(decodeKnowledgeValue(encodeKnowledgeValue(v))).toBe(v);
  });
  it("round-trips 2000 generated strings", () => {
    expect(GENERATED).toHaveLength(2000);
    for (const v of GENERATED) expect(decodeKnowledgeValue(encodeKnowledgeValue(v))).toBe(v);
  });
  it("keeps plain text readable and quotes only what needs it", () => {
    expect(encodeKnowledgeValue("a -> b")).toBe("a -> b");
    expect(encodeKnowledgeValue("C:\\Users\\alice")).toBe("C:\\Users\\alice");
    expect(encodeKnowledgeValue("中文 與 emoji 😀")).toBe("中文 與 emoji 😀");
    expect(encodeKnowledgeValue("a | b")).toBe("a | b");
    expect(encodeKnowledgeValue("a --> b")).toBe('"a --\\u003e b"');
    expect(encodeKnowledgeValue("x\ny")).toBe('"x\\ny"');
    expect(encodeKnowledgeValue("a\u2028b")).toBe('"a\\u2028b"');
    expect(encodeKnowledgeValue("a\u0085b")).toBe('"a\\u0085b"');
    expect(encodeKnowledgeValue(" lead")).toBe('" lead"');
    expect(encodeKnowledgeValue('"q"')).toBe('"\\"q\\""');
  });
  it("no encoded value contains --> or --!> or a line break", () => {
    for (const v of [...TRICKY, ...GENERATED]) {
      const e = encodeKnowledgeValue(v);
      expect(e).not.toContain("-->");
      expect(e).not.toContain("--!>");
      expect(e).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
    }
  });
  it("a quoted value that isn't one JSON string decodes to null", () => {
    expect(decodeKnowledgeValue('"a')).toBeNull();
    expect(decodeKnowledgeValue('"a" b')).toBeNull();
    expect(decodeKnowledgeValue('["a"]')).toBe('["a"]');
  });
});

describe("formatKnowledgeComment", () => {
  it("writes non-empty fields in fixed order between the mark line and -->, the status last", () => {
    expect(formatKnowledgeComment(info({ when: "alice reads this", evidence: "tested", verified: "2026-10-20", status: "unverified", supersededBy: "k_77b0e912" }), DEFAULT_KNOWLEDGE_FIELD_VIEW))
      .toBe("<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\nverified: 2026-10-20\nsuperseded_by: k_77b0e912\nstatus: needs-verify\n-->");
  });
  it("never writes evidence unconfirmed and writes the status even when none was stored", () => {
    const text = formatKnowledgeComment(info({ when: "w" }), DEFAULT_KNOWLEDGE_FIELD_VIEW);
    expect(text).not.toContain("evidence");
    expect(text).not.toContain("unconfirmed");
    expect(text).toContain("\nstatus: needs-verify\n");
  });
  it("never lets a value end the comment early", () => {
    const text = formatKnowledgeComment(info({ when: "a --> b", conclusion: "c --!> d" }), DEFAULT_KNOWLEDGE_FIELD_VIEW);
    expect(text.indexOf("-->")).toBe(text.length - 3);
    expect(text.split("\n")).toHaveLength(6);
  });
  it("the comment always writes the status by its new name and leaves out turned-off fields", () => {
    const info = { id: "k_00000001", when: "w", conclusion: "", evidence: "docs", verified: "2026-01-02", status: "", supersededBy: "", custom: {} } as const;
    expect(formatKnowledgeComment(info, DEFAULT_KNOWLEDGE_FIELD_VIEW)).toBe("<!-- knotebook:knowledge\nid: k_00000001\nwhen: w\nevidence: docs\nverified: 2026-01-02\nstatus: verified\n-->");
    expect(formatKnowledgeComment(info, viewWith({ when: false }))).not.toContain("when:");
    expect(formatKnowledgeComment({ ...info, verified: "" }, DEFAULT_KNOWLEDGE_FIELD_VIEW)).toContain("status: needs-verify");
  });
  it("a turned-off verified date is left out but still decides a legacy status", () => {
    const text = formatKnowledgeComment(info({ verified: "2026-01-02" }), viewWith({ verified: false }));
    expect(text).not.toContain("verified:");
    expect(text).toContain("status: verified");
  });
  it("writes a stored basis whose option is hidden", () => {
    const hidden = resolveKnowledgeFieldView({ defs: [], site: [{ fieldRef: "evidence", optionKey: "inferred", enabled: false, name: null, position: null }] });
    expect(formatKnowledgeComment(info({ evidence: "inferred" }), hidden)).toContain("\nevidence: inferred\n");
  });
  it("writes outdated as obsolete", () => {
    expect(formatKnowledgeComment(info({ status: "outdated" }), DEFAULT_KNOWLEDGE_FIELD_VIEW)).toContain("\nstatus: obsolete\n");
  });
  it("x- lines round-trip in field order after the builtin lines", () => {
    const text = formatKnowledgeComment(info({ when: "w", custom: { owner: "u1", team: "core", old: "hidden", gone: "x" } }), customView, new Map([["u1", "bob"]]));
    expect(text.endsWith("\nstatus: needs-verify\nx-team: core\nx-owner: bob\n-->")).toBe(true);
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("gone");
    expect(parseKnowledgeComment(dataOf(text))).toMatchObject({ ok: true, fields: { when: "w", custom: { team: "core", owner: "bob" }, unknown: [] } });
  });
  it("a member without a handle is written as user:<id>, and without a map every member is", () => {
    expect(formatKnowledgeComment(info({ custom: { owner: "u2" } }), customView, new Map([["u1", "bob"]]))).toContain("\nx-owner: user:u2\n");
    expect(formatKnowledgeComment(info({ custom: { owner: "u1" } }), customView)).toContain("\nx-owner: user:u1\n");
  });
  it("custom values are encoded like built-in ones", () => {
    for (const v of [...TRICKY, ...GENERATED].filter(storable)) {
      const parsed = parseKnowledgeComment(dataOf(formatKnowledgeComment(info({ custom: { team: v } }), customView)));
      expect(parsed).toEqual({ ok: true, fields: expect.objectContaining({ custom: v === "" ? {} : { team: v } }) });
    }
  });
});

describe("parseKnowledgeComment", () => {
  it("reads what formatKnowledgeComment writes, for every tricky value in when and conclusion", () => {
    for (const v of [...TRICKY, ...GENERATED].filter(storable)) {
      const written = info({ when: v, conclusion: v, evidence: "docs", verified: "2026-01-02", status: "outdated", supersededBy: "k_77b0e912" });
      const parsed = parseKnowledgeComment(dataOf(formatKnowledgeComment(written, DEFAULT_KNOWLEDGE_FIELD_VIEW)));
      expect(parsed).toEqual({
        ok: true,
        fields: { id: "k_8f3a2c1d", when: v, conclusion: v, evidence: "docs", verified: "2026-01-02", status: "obsolete", supersededBy: "k_77b0e912", custom: {}, unknown: [] },
      });
    }
  });
  it("round-trips values at the length limits and made of CJK and emoji", () => {
    const when = `${"測".repeat(199)}😀`;
    const conclusion = "結".repeat(300);
    const parsed = parseKnowledgeComment(dataOf(formatKnowledgeComment(info({ when, conclusion }), DEFAULT_KNOWLEDGE_FIELD_VIEW)));
    expect(parsed).toMatchObject({ ok: true, fields: { when, conclusion } });
  });
  it("unconfirmed becomes empty evidence; a missing key is empty; an unknown key is kept aside; other values come back as written, unchecked", () => {
    expect(parseKnowledgeComment(" knotebook:knowledge\nid: k_8f3a2c1d\nevidence: unconfirmed\nmood: happy\nwhen: w\n")).toEqual({
      ok: true,
      fields: { id: "k_8f3a2c1d", when: "w", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", custom: {}, unknown: [{ key: "mood", raw: "happy" }] },
    });
    expect(parseKnowledgeComment(" knotebook:knowledge\nevidence: guess\nstatus: current\nverified: 2026-02-30\n")).toMatchObject({
      ok: true,
      fields: { evidence: "guess", status: "current", verified: "2026-02-30" },
    });
  });
  it("a missing id is null", () => {
    expect(parseKnowledgeComment(" knotebook:knowledge\nwhen: w\n")).toMatchObject({ ok: true, fields: { id: null } });
    expect(parseKnowledgeComment(" knotebook:knowledge\nid:\nwhen: w\n")).toMatchObject({ ok: true, fields: { id: null } });
  });
  it("accepts CRLF line ends and trailing blank lines", () => {
    expect(parseKnowledgeComment(" knotebook:knowledge\r\nwhen: w\r\n\r\n")).toMatchObject({ ok: true, fields: { when: "w" } });
  });
  it("rejects with the problem and key", () => {
    expect(parseKnowledgeComment(" knotebook:knowledge id: k_8f3a2c1d ")).toMatchObject({ ok: false, problem: "not_multiline" });
    expect(parseKnowledgeComment(" knotebook:knowledge\nno colon here\n")).toMatchObject({ ok: false, problem: "bad_line" });
    expect(parseKnowledgeComment(" knotebook:knowledge\nwhen: a\nwhen: b\n")).toMatchObject({ problem: "duplicate_key", key: "when" });
    expect(parseKnowledgeComment(' knotebook:knowledge\nwhen: "a\n')).toMatchObject({ problem: "bad_value", key: "when" });
    expect(parseKnowledgeComment(' knotebook:knowledge\nwhen: "a" b\n')).toMatchObject({ problem: "bad_value", key: "when" });
    expect(parseKnowledgeComment(' knotebook:knowledge\nwhen: "a\\u0000b"\n')).toMatchObject({ problem: "unstorable", key: "when" });
    expect(parseKnowledgeComment(' knotebook:knowledge\nwhen: "\\ud800"\n')).toMatchObject({ problem: "unstorable" });
    expect(parseKnowledgeComment(" knotebook:knowledge\nwhen: a\n\nconclusion: b\n")).toMatchObject({ problem: "bad_line" });
  });
  it("well-formed x- lines go to custom; any other unknown key is kept aside, not refused", () => {
    const r = parseKnowledgeComment("knotebook:knowledge\nid: k_00000001\nx-owner: bob\nOwner: x\nx-負責人: bob\nwhen to read: soon\nowner: \"unterminated\nx-Team: a\nx-: b\n");
    expect(r).toEqual({ ok: true, fields: expect.objectContaining({ id: "k_00000001", custom: { owner: "bob" }, unknown: [
      { key: "Owner", raw: "x" }, { key: "x-負責人", raw: "bob" }, { key: "when to read", raw: "soon" }, { key: "owner", raw: "\"unterminated" },
      { key: "x-Team", raw: "a" }, { key: "x-", raw: "b" }] }) });
  });
  it.each([["no colon here", "bad_line"], [": value", "bad_line"], ["evidence: \"bad", "bad_value"], ["x-a: 1\nx-a: 2", "duplicate_key"]])("%s is refused as %s", (lines, problem) =>
    expect(parseKnowledgeComment(`knotebook:knowledge\n${lines}`)).toMatchObject({ ok: false, problem }));
  it("a well-formed x- key is decoded like a built-in one", () => {
    expect(parseKnowledgeComment('knotebook:knowledge\nx-a: "b\\u0000"')).toMatchObject({ ok: false, problem: "unstorable", key: "x-a" });
    expect(parseKnowledgeComment('knotebook:knowledge\nx-a: "b c"')).toMatchObject({ ok: true, fields: { custom: { a: "b c" }, unknown: [] } });
    expect(parseKnowledgeComment('knotebook:knowledge\nx-a: "b')).toMatchObject({ ok: false, problem: "bad_value", key: "x-a" });
  });
  it("an unknown key is cut at 80 code points", () => {
    const key = `${"鍵".repeat(79)}😀😀`;
    expect(parseKnowledgeComment(`knotebook:knowledge\n${key}: v`)).toMatchObject({ ok: true, fields: { unknown: [{ key: `${"鍵".repeat(79)}😀`, raw: "v" }] } });
  });
  it("isKnowledgeCommentData accepts the mark followed by whitespace or the end, nothing else", () => {
    expect(isKnowledgeCommentData(" knotebook:knowledge\n")).toBe(true);
    expect(isKnowledgeCommentData("knotebook:knowledge")).toBe(true);
    expect(isKnowledgeCommentData("knotebook:knowledgex")).toBe(false);
    expect(isKnowledgeCommentData(" note ")).toBe(false);
  });
});
