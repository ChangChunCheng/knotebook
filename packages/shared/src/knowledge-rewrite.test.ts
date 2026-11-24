import { describe, expect, it } from "vitest";
import { alignInlineText } from "./block-align.js";
import { KNOWLEDGE_ID_RE, knowledgeStateOf, type KnowledgeInfo, type KnowledgeStatus } from "./knowledge.js";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, resolveKnowledgeFieldView, type KnowledgeBuiltinFieldKey, type KnowledgeFieldView } from "./knowledge-fields.js";
import { KNOWLEDGE_PENDING_ID_PREFIX } from "./knowledge-html.js";
import { knowledgePairs, knowledgeRefsIn, normalizeKnowledgeRefs, resolveKnowledgeForWrite, sanitizeKnowledgeForWrite, type KnowledgeBlockShape } from "./knowledge-rewrite.js";

const NOTE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let seq = 0;
const H = (level: number, content: unknown, props: Record<string, unknown> = {}): KnowledgeBlockShape => ({ id: `b${(seq += 1)}`, type: "heading", props: { level, ...props }, content });
const P = (text: string): KnowledgeBlockShape => ({ id: `b${(seq += 1)}`, type: "paragraph", props: {}, content: text });
const K = (id: string, extra: Record<string, string> = {}) => ({ knowledgeId: id, knowledgeWhen: "alice reads this", ...extra });
const pending = (n = 0) => `${KNOWLEDGE_PENDING_ID_PREFIX}${n}`;
const propsOf = (b: KnowledgeBlockShape) => b.props as Record<string, unknown>;

describe("alignInlineText", () => {
  it("is block-align's inlineText: text, link text, wikilink label or [[id#anchor]]", () => {
    expect(alignInlineText([{ type: "text", text: "a" }, { type: "link", href: "x", content: [{ type: "text", text: "b" }] }])).toBe("ab");
    expect(alignInlineText([{ type: "wikilink", props: { label: "Label", targetNoteId: NOTE, anchorBlockId: "x" } }])).toBe("Label");
    expect(alignInlineText([{ type: "wikilink", props: { targetNoteId: NOTE, anchorBlockId: "x" } }])).toBe(`[[${NOTE}#x]]`);
    expect(alignInlineText("not an array")).toBe("");
  });
});

describe("knowledgePairs and resolveKnowledgeForWrite", () => {
  const resolve = (before: KnowledgeBlockShape[], after: KnowledgeBlockShape[], keep = true, taken: string[] = []) => resolveKnowledgeForWrite({ before, after, keep, taken: new Set(taken) });

  it("a heading with the same level and text and no comment gets the old seven props, id included, when keep is true; nothing when keep is false", () => {
    const old = H(2, "A", { ...K("k_00000001", { knowledgeConclusion: "c", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000002" }) });
    const before = [P("intro"), old, P("x")];
    const after = [P("intro"), H(2, "A"), P("x2")];
    const kept = resolve(before, after);
    expect(KNOWLEDGE_PROP_NAMES_OF(kept.blocks[1]!)).toEqual({
      knowledgeId: "k_00000001", knowledgeWhen: "alice reads this", knowledgeConclusion: "c", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000002",
    });
    expect(kept.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(kept.created).toEqual([]);
    expect(propsOf(kept.blocks[1]!).level).toBe(2);
    const dropped = resolve(before, after, false);
    expect(dropped.blocks[1]).toBe(after[1]);
    expect(dropped.kept).toEqual([]);
  });

  it("a changed text or level keeps nothing, even where alignBlocks pairs the two as one edited block", () => {
    const before = [H(2, "A", K("k_00000001"))];
    expect(knowledgePairs(before, [H(2, "B")])).toEqual([]);
    expect(resolve(before, [H(2, "B")]).kept).toEqual([]);
    expect(knowledgePairs(before, [H(3, "A")])).toEqual([]);
    expect(resolve(before, [H(3, "A")]).kept).toEqual([]);
    expect(knowledgePairs(before, [H(2, "A")])).toEqual([[0, 0]]);
  });

  it("bold or a link around the same text still pairs", () => {
    const before = [H(2, "A B", K("k_00000001"))];
    const after = [H(2, [{ type: "text", text: "A ", styles: { bold: true } }, { type: "link", href: "https://example.com", content: [{ type: "text", text: "B", styles: {} }] }])];
    expect(resolve(before, after).kept).toEqual([{ id: "k_00000001", heading: "A B" }]);
  });

  it("two old knowledge headings with the same text pair as alignBlocks pairs them", () => {
    const before = [H(2, "A", K("k_00000001")), P("x"), H(2, "A", K("k_00000002"))];
    const after = [H(2, "A"), P("x"), H(2, "A")];
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000001", undefined, "k_00000002"]);
    expect(r.kept.map(k => k.id)).toEqual(["k_00000001", "k_00000002"]);
  });

  it("a comment naming the id of a heading that is still there does not take its knowledge: the paired heading keeps it and the repeat gets a new id", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "orig" }))];
    const moved = H(2, "Z", K("k_00000001", { knowledgeWhen: "moved" }));
    const after = [H(2, "A"), moved];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[0]!)).toMatchObject({ knowledgeId: "k_00000001", knowledgeConclusion: "orig" });
    const fresh = propsOf(r.blocks[1]!);
    expect(fresh).toMatchObject({ knowledgeWhen: "moved" });
    expect(fresh.knowledgeId).toMatch(KNOWLEDGE_ID_RE);
    expect(fresh.knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toEqual([{ id: fresh.knowledgeId, heading: "Z", from: "k_00000001" }]);
    expect(r.created).toEqual([]);
  });

  it("the heading that was there first keeps the id wherever the repeat sits, also when the repeat comes first", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B")];
    const after = [H(2, "B"), H(2, "X", K("k_00000001", { knowledgeWhen: "moved" })), H(2, "A")];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[2]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(r.blocks[1]!).knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toEqual([{ id: propsOf(r.blocks[1]!).knowledgeId, heading: "X", from: "k_00000001" }]);
  });

  it("a renamed copy of a section that still has its original below it: the original keeps the id, the copy is renewed", () => {
    const before = [H(2, "A", K("k_00000001")), P("body")];
    const after = [H(2, "A2", K("k_00000001")), P("body"), H(2, "A"), P("new part")];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[2]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(r.blocks[0]!).knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toHaveLength(1);
    expect(r.renewed[0]).toMatchObject({ heading: "A2", from: "k_00000001" });
  });

  it("without a keep (file write) a plain heading holds nothing, so the heading that wrote the id keeps it", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const after = [H(2, "A2", K("k_00000001")), H(2, "A")];
    const r = resolve(before, after, false);
    expect(propsOf(r.blocks[0]!).knowledgeId).toBe("k_00000001");
    expect(r.renewed).toEqual([]);
  });

  it("with no heading holding the id through pairing, the written id stays with the heading paired to the old one, else the first", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const pairedLast = [H(2, "X", K("k_00000001")), H(2, "A", K("k_00000001"))];
    const a = resolve(before, pairedLast);
    expect(propsOf(a.blocks[1]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(a.blocks[0]!).knowledgeId).not.toBe("k_00000001");
    expect(a.renewed).toEqual([{ id: propsOf(a.blocks[0]!).knowledgeId, heading: "X", from: "k_00000001" }]);
    const nonePaired = [H(2, "X", K("k_00000001")), H(2, "Y", K("k_00000001")), H(2, "Z", K("k_00000001"))];
    const b = resolve(before, nonePaired);
    expect(propsOf(b.blocks[0]!).knowledgeId).toBe("k_00000001");
    const renewedIds = b.renewed.map(x => x.id);
    expect(b.blocks.slice(1).map(x => propsOf(x).knowledgeId)).toEqual(renewedIds);
    expect(new Set([...renewedIds, "k_00000001"]).size).toBe(3);
    expect(b.renewed.map(x => x.heading)).toEqual(["Y", "Z"]);
  });

  it("a heading renamed with its comment kept carries the knowledge to the new name and takes nothing from the old one", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "orig" }))];
    const renamed = H(2, "A renamed", K("k_00000001", { knowledgeConclusion: "orig" }));
    const r = resolve(before, [renamed]);
    expect(r.blocks[0]).toBe(renamed);
    expect(r.kept).toEqual([]);
    expect(r.created).toEqual([]);
  });

  it("headings that swapped places while their text is repeated are not paired by text, so neither keeps knowledge", () => {
    const before = [H(2, "A", K("k_00000001")), P("a"), H(2, "A", K("k_00000002")), P("b"), H(2, "B", K("k_00000003")), P("c")];
    const after = [H(2, "B"), P("c"), H(2, "A"), P("b"), H(2, "A"), P("a")];
    expect(knowledgePairs(before, after)).toEqual([[4, 0]]);
    const r = resolve(before, after);
    expect(r.kept.map(k => k.id)).toEqual(["k_00000003"]);
  });

  it("a comment that names another id on a paired heading wins over the old knowledge", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const after = [H(2, "A", K("k_00000009", { knowledgeWhen: "new" }))];
    const r = resolve(before, after);
    expect(r.blocks[0]).toBe(after[0]);
    expect(r.kept).toEqual([]);
  });

  it("a comment without an id line on a paired heading takes the old id; on an unpaired heading it gets a new id listed in created", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B")];
    const after = [H(2, "A", { knowledgeId: pending(0), knowledgeWhen: "edited" }), H(2, "Brand new", { knowledgeId: pending(1), knowledgeWhen: "fresh" })];
    for (const keep of [true, false]) {
      const r = resolve(before, after, keep, ["k_00000001", "k_00000003"]);
      expect(propsOf(r.blocks[0]!)).toMatchObject({ knowledgeId: "k_00000001", knowledgeWhen: "edited" });
      const made = propsOf(r.blocks[1]!).knowledgeId as string;
      expect(made).toMatch(KNOWLEDGE_ID_RE);
      expect(["k_00000001", "k_00000003"]).not.toContain(made);
      expect(r.created).toEqual([{ id: made, heading: "Brand new" }]);
      expect(r.kept).toEqual([]);
    }
  });

  it("two pending ids get two different new ids", () => {
    const after = [H(2, "A", { knowledgeId: pending(0), knowledgeWhen: "a" }), H(2, "B", { knowledgeId: pending(1), knowledgeWhen: "b" })];
    const r = resolve([], after);
    const ids = r.blocks.map(b => propsOf(b).knowledgeId as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(KNOWLEDGE_ID_RE);
  });

  it("an old note that held one id twice gets both headings back as they were", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "first" })), P("x"), H(2, "A", K("k_00000001", { knowledgeConclusion: "second" }))];
    const after = [H(2, "A"), P("x"), H(2, "A")];
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000001", undefined, "k_00000001"]);
    expect(r.blocks.map(b => propsOf(b).knowledgeConclusion)).toEqual(["first", undefined, "second"]);
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }, { id: "k_00000001", heading: "A" }]);
  });

  it("two knowledge headings swapped without comments both keep theirs", () => {
    const before = [H(2, "A", K("k_00000001")), P("a"), H(2, "B", K("k_00000002")), P("b")];
    const after = [H(2, "B"), P("b"), H(2, "A"), P("a")];
    expect(knowledgePairs(before, after).sort()).toEqual([[0, 2], [2, 0]]);
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000002", undefined, "k_00000001", undefined]);
    expect(r.kept.map(k => k.id).sort()).toEqual(["k_00000001", "k_00000002"]);
  });

  it("a heading whose level changed is not paired by the swap pass either", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B", K("k_00000002"))];
    expect(knowledgePairs(before, [H(2, "B"), H(3, "A")])).toEqual([[1, 0]]);
  });

  it("blocks that need no change keep their identity", () => {
    const before = [P("a"), H(2, "A", K("k_00000001"))];
    const after = [P("a"), H(2, "Other"), P("b")];
    const r = resolve(before, after);
    r.blocks.forEach((b, i) => expect(b).toBe(after[i]));
    const plain = resolve([], after);
    plain.blocks.forEach((b, i) => expect(b).toBe(after[i]));
  });
});

function KNOWLEDGE_PROP_NAMES_OF(b: KnowledgeBlockShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(propsOf(b))) if (k.startsWith("knowledge")) out[k] = v;
  return out;
}

describe("sanitizeKnowledgeForWrite", () => {
  const info = (over: Partial<KnowledgeInfo> = {}): KnowledgeInfo => ({ id: "k_00000001", when: "w", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", ...over });
  const viewWith = (enabled: Partial<Record<KnowledgeBuiltinFieldKey, boolean>>, hiddenOptions: string[] = []): KnowledgeFieldView =>
    resolveKnowledgeFieldView({
      defs: [],
      site: [
        ...Object.entries(enabled).map(([fieldRef, on]) => ({ fieldRef: fieldRef as KnowledgeBuiltinFieldKey, optionKey: "", enabled: on, name: null, position: null })),
        ...hiddenOptions.map(key => ({ fieldRef: "evidence" as const, optionKey: key, enabled: false, name: null, position: null })),
      ],
    });
  const run = (blocks: KnowledgeBlockShape[], current: KnowledgeInfo[] = [], fields: KnowledgeFieldView = DEFAULT_KNOWLEDGE_FIELD_VIEW, noteId: string | null = NOTE) =>
    sanitizeKnowledgeForWrite({ after: blocks, current: new Map(current.map(i => [i.id, i])), noteId, fields });
  const one = (props: Record<string, unknown>, current: KnowledgeInfo[] = [], fields?: KnowledgeFieldView, noteId?: string | null) => {
    const r = run([H(2, "Alpha", { knowledgeId: "k_00000001", ...props })], current, fields, noteId);
    return { ...r, props: propsOf(r.blocks[0]!) };
  };
  const ignoredOf = (props: Record<string, unknown>, current: KnowledgeInfo[] = [], fields?: KnowledgeFieldView, noteId?: string | null) => one(props, current, fields, noteId).ignored;

  it("a heading written back as a 0.18 file had it changes nothing and ignores nothing", () => {
    const stored = info({ when: "w", status: "", verified: "2026-01-02", evidence: "" });
    const before = { knowledgeId: "k_00000001", knowledgeWhen: "w", knowledgeConclusion: "", knowledgeEvidence: "", knowledgeVerified: "2026-01-02", knowledgeStatus: "", knowledgeSupersededBy: "" };
    const r = one(before, [stored]);
    expect(r.props).toEqual({ level: 2, ...before });
    expect(r.ignored).toEqual([]);
    expect(r.problem).toBeNull();
  });

  it("writing verified over a legacy verified heading keeps the stored empty status", () => {
    const r = one({ knowledgeWhen: "w", knowledgeVerified: "2026-01-02", knowledgeStatus: "verified" }, [info({ verified: "2026-01-02" })]);
    expect(r.props.knowledgeStatus).toBe("");
    expect(r.ignored).toEqual([]);
  });

  it("writing verified while clearing the date stores the explicit status", () => {
    const r = one({ knowledgeWhen: "w", knowledgeVerified: "", knowledgeStatus: "verified" }, [info({ verified: "2026-01-02" })]);
    expect(r.props).toMatchObject({ knowledgeStatus: "verified", knowledgeVerified: "" });
  });

  it("leaving out the status and the date makes stored legacy knowledge needs verify", () => {
    const r = one({ knowledgeWhen: "w", knowledgeVerified: "", knowledgeStatus: "" }, [info({ verified: "2026-01-02" })]);
    expect(r.props.knowledgeStatus).toBe("");
    expect(knowledgeStateOf({ status: r.props.knowledgeStatus as KnowledgeStatus, verified: r.props.knowledgeVerified as string })).toBe("needs-verify");
  });

  it("a status written by its outside name or its old name is stored by the stored name", () => {
    expect(one({ knowledgeStatus: "needs-verify" }).props.knowledgeStatus).toBe("unverified");
    expect(one({ knowledgeStatus: "obsolete" }).props.knowledgeStatus).toBe("outdated");
    expect(one({ knowledgeStatus: "unverified" }).props.knowledgeStatus).toBe("unverified");
    expect(one({ knowledgeStatus: "verified" }).props.knowledgeStatus).toBe("verified");
  });

  it("a basis that is not an offered option keeps the stored value and is reported", () => {
    const r = one({ knowledgeWhen: "w", knowledgeEvidence: "vendor-doc" }, [info({ evidence: "docs" })]);
    expect(r.props.knowledgeEvidence).toBe("docs");
    expect(r.ignored).toEqual([{ heading: "Alpha", key: "evidence", value: "vendor-doc", reason: "not_an_option" }]);
    expect(r.problem).toBeNull();
  });

  it("a stored basis key that is not an option is written back silently; a malformed one is ignored and reported", () => {
    const stored = info({ evidence: "vendor-doc" });
    const same = one({ knowledgeWhen: "w", knowledgeEvidence: "vendor-doc" }, [stored]);
    expect(same.props.knowledgeEvidence).toBe("vendor-doc");
    expect(same.ignored).toEqual([]);
    const changed = one({ knowledgeWhen: "changed", knowledgeEvidence: "vendor-doc" }, [stored]);
    expect(changed.props).toMatchObject({ knowledgeWhen: "changed", knowledgeEvidence: "vendor-doc" });
    expect(changed.ignored).toEqual([]);
    const bad = one({ knowledgeWhen: "w", knowledgeEvidence: "Vendor Doc" }, [stored]);
    expect(bad.props.knowledgeEvidence).toBe("vendor-doc");
    expect(bad.ignored).toEqual([{ heading: "Alpha", key: "evidence", value: "Vendor Doc", reason: "not_an_option" }]);
    expect(bad.problem).toBeNull();
  });

  it("unconfirmed is an empty basis", () => {
    const r = one({ knowledgeWhen: "w", knowledgeEvidence: "unconfirmed" }, [info()]);
    expect(r.props.knowledgeEvidence).toBe("");
    expect(r.ignored).toEqual([]);
    expect(one({ knowledgeEvidence: "unconfirmed" }).props.knowledgeEvidence).toBe("");
  });

  it("a turned-off field keeps its stored value whether the comment leaves it out or changes it", () => {
    const view = viewWith({ when: false });
    const stored = [info({ when: "w", conclusion: "c" })];
    const left = one({ knowledgeWhen: "", knowledgeConclusion: "c2" }, stored, view);
    expect(left.props).toMatchObject({ knowledgeWhen: "w", knowledgeConclusion: "c2" });
    expect(left.ignored).toEqual([]);
    const changed = one({ knowledgeWhen: "x", knowledgeConclusion: "c2" }, stored, view);
    expect(changed.props.knowledgeWhen).toBe("w");
    expect(changed.ignored).toEqual([{ heading: "Alpha", key: "when", value: "x", reason: "field_disabled" }]);
  });

  it("changing only a turned-off field keeps its stored value and reports it", () => {
    const r = one({ knowledgeWhen: "x", knowledgeConclusion: "c" }, [info({ when: "w", conclusion: "c" })], viewWith({ when: false }));
    expect(r.props).toMatchObject({ knowledgeWhen: "w", knowledgeConclusion: "c" });
    expect(r.ignored).toEqual([{ heading: "Alpha", key: "when", value: "x", reason: "field_disabled" }]);
    expect(r.problem).toBeNull();
    expect(one({ knowledgeWhen: "w", knowledgeConclusion: "c" }, [info({ when: "w", conclusion: "c" })], viewWith({ when: false })).ignored).toEqual([]);
  });

  it("a turned-off field is not compared, so the rest written unchanged is taken as stored", () => {
    const r = one({ knowledgeWhen: "", knowledgeConclusion: "c" }, [info({ when: "w", conclusion: "c" })], viewWith({ when: false }));
    expect(r.props.knowledgeWhen).toBe("w");
    expect(r.ignored).toEqual([]);
  });

  it("new knowledge with a bad date stores no date and reports it", () => {
    const r = one({ knowledgeVerified: "2026-13-01" });
    expect(r.props.knowledgeVerified).toBe("");
    expect(r.ignored).toEqual([{ heading: "Alpha", key: "verified", value: "2026-13-01", reason: "bad_date" }]);
  });

  it("an unknown status keeps the stored one", () => {
    const r = one({ knowledgeWhen: "w", knowledgeStatus: "current" }, [info({ status: "unverified" })]);
    expect(r.props.knowledgeStatus).toBe("unverified");
    expect(r.ignored).toEqual([{ heading: "Alpha", key: "status", value: "current", reason: "bad_status" }]);
    expect(one({ knowledgeStatus: "current" }).props.knowledgeStatus).toBe("");
  });

  it("obsolete without a replacement is accepted", () => {
    const r = one({ knowledgeWhen: "w", knowledgeStatus: "obsolete", knowledgeSupersededBy: "" });
    expect(r.props.knowledgeStatus).toBe("outdated");
    expect(r.ignored).toEqual([]);
    expect(ignoredOf({ knowledgeStatus: "outdated" }, [info({ status: "outdated" })])).toEqual([]);
  });

  it("a hidden option already stored is written back silently but cannot be newly chosen", () => {
    const view = viewWith({}, ["inferred"]);
    const r = run(
      [H(2, "Alpha", { knowledgeId: "k_00000001", knowledgeWhen: "changed", knowledgeEvidence: "inferred" }), H(2, "Beta", { knowledgeId: "k_00000002", knowledgeEvidence: "inferred" })],
      [info({ evidence: "inferred" })],
      view,
    );
    expect(propsOf(r.blocks[0]!)).toMatchObject({ knowledgeWhen: "changed", knowledgeEvidence: "inferred" });
    expect(propsOf(r.blocks[1]!).knowledgeEvidence).toBe("");
    expect(r.ignored).toEqual([{ heading: "Beta", key: "evidence", value: "inferred", reason: "not_an_option" }]);
  });

  it("a malformed id refuses the whole write unless the heading is stored and unchanged", () => {
    const bad = (props: Record<string, unknown>, current: KnowledgeInfo[] = []) =>
      run([H(2, "Alpha", { knowledgeId: "K_bad", ...props })], current.map(i => ({ ...i, id: "K_bad" })));
    expect(bad({ knowledgeWhen: "w" }).problem).toEqual({ problem: "bad_id", key: "id", heading: "Alpha" });
    expect(bad({ knowledgeWhen: "w" }, [info()]).problem).toBeNull();
    const legacy = info({ verified: "2026-01-02" });
    const exported = bad({ knowledgeWhen: "w", knowledgeVerified: "2026-01-02", knowledgeStatus: "verified" }, [legacy]);
    expect(exported.problem).toBeNull();
    expect(propsOf(exported.blocks[0]!)).toMatchObject({ knowledgeId: "K_bad", knowledgeWhen: "w", knowledgeVerified: "2026-01-02", knowledgeStatus: "" });
    expect(bad({ knowledgeWhen: "changed" }, [info()]).problem).toMatchObject({ problem: "bad_id" });
  });

  it("line breaks and over-long text keep the stored value", () => {
    for (const code of [0x0d, 0x0a, 0x85, 0x2028, 0x2029]) {
      const text = `a${String.fromCharCode(code)}b`;
      expect(ignoredOf({ knowledgeWhen: text })).toEqual([{ heading: "Alpha", key: "when", value: text, reason: "line_break" }]);
      expect(ignoredOf({ knowledgeConclusion: text })).toEqual([{ heading: "Alpha", key: "conclusion", value: text, reason: "line_break" }]);
    }
    const r = one({ knowledgeWhen: "a\nb", knowledgeConclusion: "c".repeat(301) }, [info({ when: "w", conclusion: "c" })]);
    expect(r.props).toMatchObject({ knowledgeWhen: "w", knowledgeConclusion: "c" });
    expect(r.ignored.map(i => [i.key, i.reason])).toEqual([["when", "line_break"], ["conclusion", "too_long"]]);
    expect(ignoredOf({ knowledgeWhen: "a\tb" })).toEqual([]);
    expect(ignoredOf({ knowledgeWhen: "w".repeat(201) })).toMatchObject([{ key: "when", reason: "too_long" }]);
  });

  it("200 CJK characters with an emoji fit when; 300 fit conclusion", () => {
    expect(ignoredOf({ knowledgeWhen: `${"測".repeat(199)}😀` })).toEqual([]);
    expect(ignoredOf({ knowledgeWhen: `${"測".repeat(200)}😀` })).toMatchObject([{ reason: "too_long" }]);
    expect(ignoredOf({ knowledgeConclusion: "結".repeat(300) })).toEqual([]);
    expect(ignoredOf({ knowledgeConclusion: `${"結".repeat(299)}😀` })).toEqual([]);
  });

  it("a replacement that is not a reference or names this very knowledge keeps the stored value", () => {
    expect(ignoredOf({ knowledgeSupersededBy: "x#k_1" })).toEqual([{ heading: "Alpha", key: "superseded_by", value: "x#k_1", reason: "bad_ref" }]);
    expect(ignoredOf({ knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" })).toMatchObject([{ key: "superseded_by", reason: "superseded_self" }]);
    expect(ignoredOf({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${NOTE}#k_00000001` })).toMatchObject([{ reason: "superseded_self" }]);
    expect(ignoredOf({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${OTHER}#k_00000001` })).toEqual([]);
    expect(ignoredOf({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${NOTE}#k_00000001` }, [], undefined, null)).toEqual([]);
    const kept = one({ knowledgeSupersededBy: "k_00000001" }, [info({ supersededBy: "k_00000002" })]);
    expect(kept.props.knowledgeSupersededBy).toBe("k_00000002");
  });

  it("a stored knowledge with a line break or an over-long when is accepted when written back unchanged", () => {
    const long = "w".repeat(250);
    expect(ignoredOf({ knowledgeWhen: "x\r\ny", knowledgeConclusion: "c d" }, [info({ when: "x\r\ny", conclusion: "c d" })])).toEqual([]);
    expect(ignoredOf({ knowledgeWhen: long }, [info({ when: long })])).toEqual([]);
    // Unchanged fields are not checked even when another field changes.
    const r = one({ knowledgeWhen: long, knowledgeConclusion: "now" }, [info({ when: long })]);
    expect(r.props).toMatchObject({ knowledgeWhen: long, knowledgeConclusion: "now" });
    expect(r.ignored).toEqual([]);
  });

  it("every problem in every heading is reported in document order; only knowledge headings are looked at", () => {
    const blocks = [P("x"), H(2, "Fine", { knowledgeId: "k_00000001", knowledgeWhen: "w" }), H(2, "Broken", { knowledgeId: "k_00000002", knowledgeEvidence: "guess", knowledgeVerified: "soon" }), H(2, "Plain")];
    const r = run(blocks);
    expect(r.problem).toBeNull();
    expect(r.ignored).toEqual([
      { heading: "Broken", key: "evidence", value: "guess", reason: "not_an_option" },
      { heading: "Broken", key: "verified", value: "soon", reason: "bad_date" },
    ]);
    expect(r.blocks[0]).toBe(blocks[0]);
    expect(r.blocks[3]).toBe(blocks[3]);
  });

  it("leaves its input untouched", () => {
    const blocks = [H(2, "Alpha", { knowledgeId: "k_00000001", knowledgeEvidence: "guess" })];
    const r = run(blocks);
    expect(propsOf(blocks[0]!).knowledgeEvidence).toBe("guess");
    expect(propsOf(r.blocks[0]!).knowledgeEvidence).toBe("");
  });
});

describe("normalizeKnowledgeRefs", () => {
  it("turns <this note>#k_x into k_x and leaves other notes' refs alone", () => {
    const own = H(2, "A", K("k_00000001", { knowledgeSupersededBy: `${NOTE.toUpperCase()}#k_00000002` }));
    const other = H(2, "B", K("k_00000003", { knowledgeSupersededBy: `${OTHER}#k_00000004` }));
    const bare = H(2, "C", K("k_00000005", { knowledgeSupersededBy: "k_00000006" }));
    const plain = P("p");
    const out = normalizeKnowledgeRefs([own, other, bare, plain], NOTE);
    expect(propsOf(out[0]!).knowledgeSupersededBy).toBe("k_00000002");
    expect(out[1]).toBe(other);
    expect(out[2]).toBe(bare);
    expect(out[3]).toBe(plain);
  });
});

describe("knowledgeRefsIn", () => {
  it("lists top-level knowledge headings in document order", () => {
    expect(knowledgeRefsIn([P("x"), H(2, "A", K("k_00000001")), H(3, "Plain"), H(1, [{ type: "text", text: "B" }], K("k_00000002"))])).toEqual([
      { id: "k_00000001", heading: "A" },
      { id: "k_00000002", heading: "B" },
    ]);
  });
});
