import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { exportedLinkTextOf, keepLabelFree, labelFreeLinkTexts, linkTextHash } from "../../src/transfer/link-texts.js";
import { TEST_KEY, TEST_SALT, docWith, forkOf, makeBaseInMemory, planInMemory } from "./fixtures/transfer-sync.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const T = "abcdef11-1111-4111-8111-111111111111"; // contains letters: the case assertions only mean something then
const U = "22222222-2222-4222-8222-222222222222";
const cand = (id: string, title: string) => ({ id, title, slug: "s", groupId: null, ownerHandle: "x" });
const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: T, snapshotTitle: "Old snapshot", ...props } });
const linkPara = (lead: string, props: Record<string, string> = {}) => ({ type: "paragraph", content: [{ type: "text", text: lead, styles: {} }, wl(props)] });
const P = (t: string) => ({ type: "paragraph", content: t });
const ok = <R extends { ok: boolean }>(r: R): Extract<R, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<R, { ok: true }>;
};
function wikilinksOf(parsed: unknown[][]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const o = x as { type?: unknown; props?: Record<string, unknown> };
      if (o.type === "wikilink") out.push(o.props ?? {});
      Object.values(x).forEach(walk);
    }
  };
  walk(parsed);
  return out;
}

describe("labelFreeLinkTexts / keepLabelFree", () => {
  it("collects only wikilinks without custom text (including child blocks and table cells); the text = what the export shows (current title, snapshotTitle when not found)", () => {
    const blocks = [
      { type: "paragraph", content: [wl({}), wl({ label: "Custom" })], children: [{ type: "paragraph", content: [wl({ targetNoteId: U })], children: [] }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({ targetNoteId: T.toUpperCase() })]] }] }, children: [] },
    ];
    expect(labelFreeLinkTexts(blocks, new Map([[T, "Target v1"]]))).toEqual([
      [T, "Target v1"],
      [U, "Old snapshot"],
      [T, "Target v1"],
    ]);
  });

  it("keepLabelFree: a label equal to the export text from download -> cleared and snapshotTitle replaced with the current title; others untouched (returns the same array)", () => {
    const exported = (id: string, text: string) => id === T && text === "Target v1";
    const blocks = [{ type: "paragraph", content: [wl({ label: "Target v1" }), wl({ label: "Mine" }), wl({ targetNoteId: U, label: "Target v1" })] }];
    const [out, n] = keepLabelFree(blocks, exported, id => (id === T ? "Target v2" : undefined));
    expect(n).toBe(1);
    expect(wikilinksOf([out]).map(p => [p.label, p.snapshotTitle])).toEqual([["", "Target v2"], ["Mine", "Old snapshot"], ["Target v1", "Old snapshot"]]);
    const untouched = [P("x")];
    expect(keepLabelFree(untouched, exported, () => undefined)[0]).toBe(untouched);
  });

  it("exportedLinkTextOf: merges the links of all segments; none at all -> undefined; ids are case-insensitive", () => {
    const h = linkTextHash(TEST_KEY, TEST_SALT, T, "Target v1");
    expect(exportedLinkTextOf([{ ids: ["a"], fps: ["f"], start: 0, count: 1 }], TEST_KEY, TEST_SALT)).toBeUndefined();
    const f = exportedLinkTextOf([{ ids: ["a"], fps: ["f"], start: 0, count: 1 }, { ids: ["b"], fps: ["g"], start: 1, count: 1, links: [h] }], TEST_KEY, TEST_SALT)!;
    expect(f(T, "Target v1")).toBe(true);
    expect(f(T.toUpperCase(), "Target v1")).toBe(true);
    expect(f(T, "Target v2")).toBe(false);
    expect(f(U, "Target v1")).toBe(false);
    expect(linkTextHash(TEST_KEY, Buffer.alloc(16, 1), T, "Target v1")).not.toBe(h); // salted
  });
});

describe("the export segment table carries links, and \"no custom text\" is preserved when planning", () => {
  it("segment table: only segments containing a wikilink without custom text carry links (deduplicated); an export without linkHash carries none", async () => {
    const doc = await docWith(rt, [linkPara("See ", {}), P("Para"), linkPara("Mine ", { label: "Custom" })]);
    const b = await makeBaseInMemory(rt, doc, new Map([[T, "Target v1"]]));
    const segs = b.base.segments!;
    expect(segs.map(s => s.links)).toEqual([[linkTextHash(TEST_KEY, TEST_SALT, T, "Target v1")], undefined, undefined]);
  });

  const scene = async (props: Record<string, string> = {}) => {
    const doc = await docWith(rt, [linkPara("See ", props), P("Para 2")]);
    const b = await makeBaseInMemory(rt, doc, new Map([[T, "Target v1"]]));
    return { doc, b };
  };

  it("the target is renamed after download and the agent changes other text in the same segment (link text untouched) -> label empty, snapshotTitle = current title", async () => {
    const { doc, b } = await scene();
    expect(b.body).toContain(`[Target v1](/notes/${T})`);
    const r = ok(await planInMemory(rt, b, b.body.replace("See ", "Look "), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(wikilinksOf(r.plan.parsed)).toEqual([{ targetNoteId: T, snapshotTitle: "Target v2", label: "", anchorBlockId: "" }]);
  });

  it("the target is renamed and the link rewritten as a full-site URL (reads back the same) -> this region is same (not written)", async () => {
    const { doc, b } = await scene();
    const r = ok(await planInMemory(rt, b, b.body.replace(`](/notes/${T})`, `](http://localhost/notes/${T})`), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(r.plan.decisions.map(d => `${d.kind}:${d.mark}`)).toEqual(["rewrite:same"]);
  });

  it("the agent changes the link text to something else (including the base's snapshotTitle) -> stored as custom text", async () => {
    for (const text of ["My words", "Old snapshot"]) {
      const { doc, b } = await scene();
      const r = ok(await planInMemory(rt, b, b.body.replace("[Target v1]", `[${text}]`), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
      expect(wikilinksOf(r.plan.parsed).map(p => p.label)).toEqual([text]);
    }
  });

  it("had custom text originally -> stays custom text", async () => {
    const { doc, b } = await scene({ label: "Custom words" });
    const r = ok(await planInMemory(rt, b, b.body.replace("See ", "Look "), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(wikilinksOf(r.plan.parsed).map(p => p.label)).toEqual(["Custom words"]);
  });
});
