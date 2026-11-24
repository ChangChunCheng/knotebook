// Knowledge info over MCP: what read_note_section shows, what edit_note and create_note do with a knowledge comment, and what they say about it.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { setNoteTagsByNamesInTx } from "../src/tags/tx/note-tags.js";
import { MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { seedBlocks, callTool, type ToolCallResult } from "./bulk-transfer-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const K1 = "k_00000001";
const H = (id: string, text: string, props: Record<string, unknown> = {}, level = 2) => ({ id, type: "heading", props: { level, ...props }, content: text });
const KH = (id: string, text: string, knowledgeId: string, extra: Record<string, unknown> = {}) => H(id, text, { knowledgeId, knowledgeWhen: "alice reads this", ...extra });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });
const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;

interface KnowledgeOut { kept: Array<{ id: string; heading: string; headingTruncated?: true }>; created: Array<{ id: string; heading: string; headingTruncated?: true }>; removed: Array<{ id: string; heading: string; headingTruncated?: true }>; renewed: Array<{ id: string; heading: string; from: string }>; ignored: Array<{ heading: string; key: string; value: string; reason: string; headingTruncated?: true; keyTruncated?: true; valueTruncated?: true }>; ignoredComments: number; truncated: boolean }
const ok = (r: ToolCallResult): Record<string, unknown> => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
  return r.structuredContent;
};
const knowledgeOf = (r: ToolCallResult): KnowledgeOut | undefined => ok(r).knowledge as KnowledgeOut | undefined;

async function setup(blocks: unknown[]) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedBlocks(ctx.db, note.id, blocks);
  const call = (name: string, args: Record<string, unknown>) => callTool(ctx.app, pat.token, name, args);
  const section = async (id: string) => {
    const r = ok(await call("read_note_section", { note_id: note.id, section_id: id })) as { section: { markdown: string; fingerprint: string } };
    return r.section;
  };
  const wholeFingerprint = async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content`, headers: { authorization: `Bearer ${pat.token}` } });
    return (res.json() as { fingerprint: string }).fingerprint;
  };
  const edit = (args: Record<string, unknown>) => call("edit_note", { note_id: note.id, ...args });
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
  const putFields = async (opts: { off?: string[]; extraOptions?: Array<{ key: string; name: string }> }) => {
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const fields = (["when", "conclusion", "evidence", "verified", "superseded_by"] as const).map(key => ({
      key,
      enabled: !(opts.off ?? []).includes(key),
      ...(key === "evidence" ? { options: [...["tested", "docs", "inferred"].map(o => ({ key: o, name: null, enabled: true })), ...(opts.extraOptions ?? []).map(o => ({ ...o, enabled: true }))] } : {}),
    }));
    const res = await ctx.app.inject({ method: "PUT", url: "/api/admin/knowledge-fields", cookies: await cookieOf(admin.id), payload: { fields } });
    expect(res.statusCode, res.body).toBe(200);
  };
  return { ctx, u, pat, note, call, section, wholeFingerprint, edit, infos, putFields };
}
type S = Awaited<ReturnType<typeof setup>>;
interface FieldsOut { status: string[]; fields: Array<{ key: string; name: string; type: string; options?: Array<{ key: string; name: string }>; optionsTruncated?: true }> }

describe("tool schemas", () => {
  it("tools/list shows knowledge in edit_note's and create_note's output schema and tags in read_note_outline's note", async () => {
    const s = await setup([P("p1", "x")]);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.pat.token });
    type Schema = { properties: Record<string, { properties?: Record<string, unknown>; description?: string }> };
    const tools = res.json().result.tools as Array<{ name: string; outputSchema: Schema }>;
    const out = (n: string) => tools.find(t => t.name === n)!.outputSchema;
    expect(Object.keys(out("edit_note").properties)).toContain("knowledge");
    expect(Object.keys(out("edit_note").properties.knowledge!.properties ?? {}).sort()).toEqual(["created", "ignored", "ignoredComments", "kept", "removed", "renewed", "truncated"]);
    expect(Object.keys(out("create_note").properties)).toContain("knowledge");
    expect(Object.keys(out("read_note_outline").properties.note!.properties ?? {})).toContain("tags");
    for (const tool of ["read_note_outline", "create_note"]) {
      const fields = out(tool).properties.knowledgeFields!;
      expect(Object.keys(fields.properties ?? {}).sort(), tool).toEqual(["fields", "status"]);
      const entry = (fields.properties!.fields as { items: { properties: Record<string, unknown> } }).items;
      expect(Object.keys(entry.properties).sort(), tool).toEqual(["key", "name", "options", "optionsTruncated", "type"]);
    }
    await s.ctx.destroy();
  });
});

describe("reading", () => {
  it("read_note_outline's note.tags lists the tags in the order added, [] without tags, and the owner's tags to a share viewer", async () => {
    const s = await setup([P("p1", "x")]);
    const before = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(before.tags).toEqual([]);
    await s.ctx.db.transaction(tx => setNoteTagsByNamesInTx(tx, { noteId: s.note.id, expected: { ownerId: s.u.id, groupId: null }, names: ["zulu", "alpha", "Mike"], createdBy: s.u.id }));
    const after = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(after.tags).toEqual(["zulu", "alpha", "Mike"]);
    const viewer = await seedUser(s.ctx.db);
    await seedShare(s.ctx.db, s.note.id, viewer.id, "viewer");
    const viewerToken = await seedTokenForUser(s.ctx.db, viewer.id, "notes:read");
    const seen = ok(await callTool(s.ctx.app, viewerToken.token, "read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(seen.tags).toEqual(["zulu", "alpha", "Mike"]);
    await s.ctx.destroy();
  });

  it("read_note_section returns the comment under a knowledge heading", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "keep" }), P("a1", "body")]);
    const sec = await s.section("hA");
    expect(sec.markdown).toBe(`## A\n${comment([`id: ${K1}`, "when: alice reads this", "conclusion: keep", "status: needs-verify"])}\n\nbody\n`);
    await s.ctx.destroy();
  });

  it("the first outline page lists the space's enabled fields and later pages don't", async () => {
    const s = await setup([P("p0", "intro"), ...Array.from({ length: 120 }, (_, i) => H(`h${i}`, `Heading ${i}`))]);
    const before = ok(await s.call("read_note_outline", { note_id: s.note.id })).knowledgeFields as FieldsOut;
    expect(before.fields.map(f => [f.key, f.name, f.type])).toEqual([
      ["when", "When to read", "text"],
      ["conclusion", "Conclusion", "text"],
      ["evidence", "Basis", "select"],
      ["verified", "Last verified", "date"],
      ["superseded_by", "Replaced by", "ref"],
    ]);
    await s.putFields({ off: ["conclusion"], extraOptions: [{ key: "vendor-doc", name: "Vendor docs" }] });
    const first = ok(await s.call("read_note_outline", { note_id: s.note.id }));
    const fields = first.knowledgeFields as FieldsOut;
    expect(fields.status).toEqual(["verified", "needs-verify", "obsolete"]);
    expect(fields.fields.map(f => f.key)).toEqual(["when", "evidence", "verified", "superseded_by"]);
    expect(fields.fields.find(f => f.key === "evidence")!.options).toEqual([
      { key: "tested", name: "Tested" },
      { key: "docs", name: "Documentation" },
      { key: "inferred", name: "Inferred" },
      { key: "vendor-doc", name: "Vendor docs" },
    ]);
    expect(fields.fields.filter(f => f.key !== "evidence").every(f => !("options" in f))).toBe(true);
    expect(ok(await s.call("read_note_outline", { note_id: s.note.id, section_offset: 0 }))).toHaveProperty("knowledgeFields");
    const later = ok(await s.call("read_note_outline", { note_id: s.note.id, section_offset: MCP_PAGE_MAX }));
    expect((later.sections as unknown[]).length).toBeGreaterThan(0);
    expect(later).not.toHaveProperty("knowledgeFields");
    await s.ctx.destroy();
  });

  it("read_note_section leaves out a turned-off field that has a stored value", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "c" }), P("a1", "body")]);
    await s.putFields({ off: ["conclusion"] });
    const sec = await s.section("hA");
    expect(sec.markdown).toBe(`## A\n${comment([`id: ${K1}`, "when: alice reads this", "status: needs-verify"])}\n\nbody\n`);
    expect(sec.markdown).not.toContain("conclusion:");
    const rest = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: { authorization: `Bearer ${s.pat.token}` } });
    expect((rest.json() as { markdown: string }).markdown).toBe(sec.markdown);
    expect((await s.infos()).get(K1)).toMatchObject({ conclusion: "c" });
    await s.ctx.destroy();
  });

  it("a group note's outline lists the site's fields, as the group has no settings of its own", async () => {
    const s = await setup([P("p1", "x")]);
    await s.putFields({ off: ["when"] });
    const g = await seedGroup(s.ctx.db, "Team", [{ userId: s.u.id, role: "member" }]);
    const gn = await seedNote(s.ctx.db, { groupId: g.id }, { title: "Group note" });
    const fields = ok(await s.call("read_note_outline", { note_id: gn.id })).knowledgeFields as FieldsOut;
    expect(fields.fields.map(f => f.key)).toEqual(["conclusion", "evidence", "verified", "superseded_by"]);
    await s.ctx.destroy();
  });
});

describe("edit_note", () => {
  it("replace_section without the comment keeps the knowledge; the reply's knowledge.kept names it", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "old")]);
    const sec = await s.section("hA");
    const k = knowledgeOf(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: "## A\n\nnew\n" }));
    expect(k).toEqual({ kept: [{ id: K1, heading: "A" }], created: [], removed: [], renewed: [], ignored: [], ignoredComments: 0, truncated: false });
    expect((await s.infos()).get(K1)).toMatchObject({ when: "alice reads this" });
    await s.ctx.destroy();
  });

  it("knowledge lists are cut at 100 with truncated true, headings at 200 characters with headingTruncated", async () => {
    const blocks = [P("p0", "intro"), ...Array.from({ length: 120 }, (_, i) => KH(`h${i}`, `Heading ${i}`, `k_${String(i + 1).padStart(8, "0")}`)), KH("hLong", "L".repeat(300), "k_00000999")];
    const s = await setup(blocks);
    const k = knowledgeOf(await s.edit({ op: "replace_all", if_match: await s.wholeFingerprint(), markdown: "just text" }))!;
    expect(k.removed).toHaveLength(MCP_PAGE_MAX);
    expect(k.truncated).toBe(true);
    await s.ctx.destroy();
    const t = await setup([KH("hLong", "L".repeat(300), K1), P("p1", "x")]);
    const long = knowledgeOf(await t.edit({ op: "replace_all", if_match: await t.wholeFingerprint(), markdown: "just text" }))!;
    expect(long.removed[0]!.heading).toHaveLength(200);
    expect(long.removed[0]!.headingTruncated).toBe(true);
    expect(long.truncated).toBe(false);
    await t.ctx.destroy();
  });

  it("an invalid comment is the invalid_knowledge tool error with the heading in the message", async () => {
    const s = await setup([P("p1", "x")]);
    const r = await s.edit({ op: "append", markdown: "## Z\n<!-- knotebook:knowledge\nsome line\n-->\n\nbody\n" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "Z" has a line that isn\'t key: value. Nothing was written.' });
    await s.ctx.destroy();
  });

  it("markdown starting with #todo #urgent written by edit_note replace_all is a paragraph with that text, the note gets no tags, and it reads back as #todo #urgent", async () => {
    const s = await setup([P("p1", "x")]);
    ok(await s.edit({ op: "replace_all", if_match: await s.wholeFingerprint(), markdown: "#todo #urgent\n\nbody\n" }));
    const sec = await s.section("_top");
    expect(sec.markdown.startsWith("#todo #urgent\n")).toBe(true);
    const outline = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(outline.tags).toEqual([]);
    await s.ctx.destroy();
  });
});

describe("create_note", () => {
  it("with content holding a comment after a paragraph reports ignoredComments 1; one under a heading is listed in created", async () => {
    const s = await setup([P("p1", "x")]);
    const ignored = knowledgeOf(await s.call("create_note", { title: "A", content: `text\n\n${comment(["when: nowhere"])}\n\nmore\n` }))!;
    expect(ignored).toEqual({ kept: [], created: [], removed: [], renewed: [], ignored: [], ignoredComments: 1, truncated: false });
    const created = knowledgeOf(await s.call("create_note", { title: "B", content: `## D1\n${comment(["when: w"])}\n\nbody\n` }))!;
    expect(created.created).toHaveLength(1);
    expect(created.created[0]!.heading).toBe("D1");
    expect(created.created[0]!.id).toMatch(/^k_[0-9a-f]{8}$/);
    expect(created.ignoredComments).toBe(0);
    await s.ctx.destroy();
  });

  it("with content that writes a new id in full lists it in created, so the reply says what was stored", async () => {
    const s = await setup([P("p1", "x")]);
    const k = knowledgeOf(await s.call("create_note", { title: "C", content: `## A
${comment(["id: k_12345678", "when: w"])}

body
` }))!;
    expect(k).toEqual({ kept: [], created: [{ id: "k_12345678", heading: "A" }], removed: [], renewed: [], ignored: [], ignoredComments: 0, truncated: false });
    await s.ctx.destroy();
  });

  it("whose content has a malformed id is the invalid_knowledge tool error naming the heading, not internal, and no note is left", async () => {
    const s = await setup([P("p1", "x")]);
    const before = (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const r = await s.call("create_note", { title: "Bad", content: `## D1\n${comment(["id: K_bad", "when: w"])}\n\nx\n` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: "The knowledge comment under the heading \"D1\" has an `id` that isn't k_ followed by 8 lowercase hex digits (leave the id line out for new knowledge). Nothing was written." });
    expect((await s.ctx.db.select({ id: notes.id }).from(notes)).length).toBe(before);
    expect(await s.ctx.db.select().from(notes).where(eq(notes.title, "Bad"))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("whose content has a superseded_by that isn't a reference creates the note with no replacement", async () => {
    const s = await setup([P("p1", "x")]);
    const r = await s.call("create_note", { title: "Loose", content: `## D1\n${comment(["when: w", "status: outdated", "superseded_by: nope"])}\n\nx\n` });
    expect(knowledgeOf(r)!.ignored).toEqual([{ heading: "D1", key: "superseded_by", value: "nope", reason: "bad_ref" }]);
    const id = (ok(r).note as { id: string }).id;
    const doc = (await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, id)).doc;
    expect([...knowledgeInfoById(doc.getXmlFragment(YDOC_FRAGMENT)).values()]).toMatchObject([{ when: "w", status: "outdated", supersededBy: "" }]);
    await s.ctx.destroy();
  });

  it("create_note's reply carries the target space's field definitions, with content or without", async () => {
    const s = await setup([P("p1", "x")]);
    await s.putFields({ off: ["verified"], extraOptions: [{ key: "vendor-doc", name: "Vendor docs" }] });
    const g = await seedGroup(s.ctx.db, "Team", [{ userId: s.u.id, role: "member" }]);
    const outline = ok(await s.call("read_note_outline", { note_id: s.note.id })).knowledgeFields as FieldsOut;
    expect(outline.fields.map(f => f.key)).toEqual(["when", "conclusion", "evidence", "superseded_by"]);
    for (const args of [{ title: "Empty" }, { title: "Filled", content: `## D1\n${comment(["when: w"])}\n\nbody\n` }, { title: "In group", group_id: g.id }, { title: "In group filled", group_id: g.id, content: "text\n" }]) {
      expect(ok(await s.call("create_note", args)).knowledgeFields, args.title).toEqual(outline);
    }
    await s.ctx.destroy();
  });

  it("content starting with #todo #urgent is a paragraph with that text and the note gets no tags", async () => {
    const s = await setup([P("p1", "x")]);
    const created = ok(await s.call("create_note", { title: "Tagless", content: "#todo #urgent\n\nbody\n" })).note as { id: string };
    const sec = ok(await s.call("read_note_section", { note_id: created.id, section_id: "_top" })) as { section: { markdown: string } };
    expect(sec.section.markdown.startsWith("#todo #urgent\n")).toBe(true);
    expect((ok(await s.call("read_note_outline", { note_id: created.id })).note as { tags: string[] }).tags).toEqual([]);
    await s.ctx.destroy();
  });
});

describe("each claim in the new describe text holds", () => {
  async function written(s: S, markdown: string, op: "append" | "replace_all" = "append"): Promise<KnowledgeOut | undefined> {
    const args = op === "append" ? { op, markdown } : { op, markdown, if_match: await s.wholeFingerprint() };
    return knowledgeOf(await s.edit(args));
  }

  it("a comment under a heading in a list, a quote or columns is ignored and counted", async () => {
    const s = await setup([P("p1", "x")]);
    const k = await written(
      s,
      `> ## In quote\n> ${comment(["when: q"]).replace(/\n/g, "\n> ")}\n>\n> text\n\n- ## In list\n  ${comment(["when: l"]).replace(/\n/g, "\n  ")}\n\n  text\n`,
    );
    expect(k?.created ?? []).toEqual([]);
    expect(k?.ignoredComments).toBeGreaterThanOrEqual(1);
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("leaving out status on obsolete knowledge doesn't keep obsolete: it is read from the last-verified date again", async () => {
    const K2 = "k_00000002";
    const s = await setup([KH("hA", "A", K1, { knowledgeStatus: "outdated", knowledgeVerified: "2026-10-20" }), P("a1", "body"), KH("hB", "B", K2, { knowledgeStatus: "outdated" }), P("b1", "body")]);
    for (const [id, kid, expected] of [["hA", K1, "verified"], ["hB", K2, "needs-verify"]] as const) {
      const sec = await s.section(id);
      expect(sec.markdown, id).toContain("status: obsolete\n");
      const markdown = sec.markdown.replace("status: obsolete\n", "");
      ok(await s.edit({ op: "replace_section", section_id: id, if_match: sec.fingerprint, markdown }));
      expect((await s.infos()).get(kid)!.status, id).not.toBe("outdated");
      expect((await s.section(id)).markdown, id).toContain(`status: ${expected}\n`);
    }
    await s.ctx.destroy();
  });

  it("leaving out a line empties a field the outline lists; a field it doesn't list keeps its value", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "was", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20" }), P("a1", "body")]);
    await s.putFields({ off: ["verified"] });
    const listed = (ok(await s.call("read_note_outline", { note_id: s.note.id })).knowledgeFields as FieldsOut).fields.map(f => f.key);
    expect(listed).toContain("conclusion");
    expect(listed).not.toContain("verified");
    const sec = await s.section("hA");
    ok(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: `## A\n${comment([`id: ${K1}`, "when: still"])}\n\nbody\n` }));
    expect((await s.infos()).get(K1)).toMatchObject({ when: "still", conclusion: "", evidence: "", verified: "2026-10-20" });
    await s.ctx.destroy();
  });

  it("knowledgeFields gives each listed key's type, and a select field's options, which are the values a comment can write", async () => {
    const s = await setup([P("p1", "x")]);
    await s.putFields({ extraOptions: [{ key: "vendor-doc", name: "Vendor docs" }] });
    const fields = (ok(await s.call("read_note_outline", { note_id: s.note.id })).knowledgeFields as FieldsOut).fields;
    for (const f of fields) expect(["text", "select", "date", "link", "member", "ref"], f.key).toContain(f.type);
    const options = fields.filter(f => f.type === "select").flatMap(f => f.options!.map(o => o.key));
    expect(options).toContain("vendor-doc");
    const k = knowledgeOf(await s.edit({ op: "append", markdown: `## B\n${comment(["evidence: vendor-doc"])}\n\nx\n` }))!;
    expect(k.ignored).toEqual([]);
    expect([...(await s.infos()).values()]).toMatchObject([{ evidence: "vendor-doc" }]);
    await s.ctx.destroy();
  });

  it("insert_after and append without a comment make plain headings", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const sec = await s.section("hA");
    expect(await written(s, "## A\n\ntext\n")).toBeUndefined();
    ok(await s.edit({ op: "insert_after", section_id: "hA", if_match: sec.fingerprint, markdown: "## B\n\ntext\n" }));
    expect([...(await s.infos()).keys()]).toEqual([K1]);
    await s.ctx.destroy();
  });

  it("evidence unconfirmed is stored as empty", async () => {
    const s = await setup([P("p1", "x")]);
    const k = (await written(s, `## U\n${comment(["when: w", "evidence: unconfirmed"])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ evidence: "" });
    await s.ctx.destroy();
  });

  it("a value in double quotes is read as a JSON string", async () => {
    const s = await setup([P("p1", "x")]);
    const k = (await written(s, `## Q\n${comment([`when: "say \\"hi\\" \\u003e done"`])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ when: 'say "hi" > done' });
    await s.ctx.destroy();
  });

  it("status current is not stored, and verified, needs-verify, obsolete and the old unverified and outdated are", async () => {
    const s = await setup([P("p1", "x")]);
    const status = async (heading: string, value: string) => {
      const k = knowledgeOf(await s.edit({ op: "append", markdown: `## ${heading}\n${comment(["when: w", `status: ${value}`])}\n\nx\n` }))!;
      return (await s.infos()).get(k.created[0]!.id)!.status;
    };
    expect(await status("C", "current")).toBe("");
    expect(await status("U", "unverified")).toBe("unverified");
    expect(await status("N", "needs-verify")).toBe("unverified");
    expect(await status("V", "verified")).toBe("verified");
    expect(await status("O", "obsolete")).toBe("outdated");
    expect(await status("D", "outdated")).toBe("outdated");
    await s.ctx.destroy();
  });

  it("superseded_by may be a knowledge id or <note id>#<knowledge id> in another note, and outdated can leave it out", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "x")]);
    const other = "22222222-2222-4222-8222-222222222222";
    const k = (await written(s, `## Old\n${comment(["when: w", "status: outdated", `superseded_by: ${other}#k_00000002`])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ status: "outdated", supersededBy: `${other}#k_00000002` });
    const none = (await written(s, `## Gone\n${comment(["when: w", "status: outdated"])}\n\nx\n`))!;
    expect((await s.infos()).get(none.created[0]!.id)).toMatchObject({ status: "outdated", supersededBy: "" });
    await s.ctx.destroy();
  });

  it("a line whose key isn't known, or whose value doesn't fit its field, isn't written: it is listed in knowledge.ignored and the field keeps its value", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeEvidence: "docs", knowledgeVerified: "2026-10-01" }), P("a1", "body")]);
    const sec = await s.section("hA");
    const k = knowledgeOf(await s.edit({
      op: "replace_section", section_id: "hA", if_match: sec.fingerprint,
      markdown: `## A\n${comment([`id: ${K1}`, "when: changed", "evidence: guess", "verified: 2026-02-30", "status: maybe", "Owner: bob"])}\n\nbody\n`,
    }))!;
    expect(k.ignored).toEqual([
      { heading: "A", key: "Owner", value: "bob", reason: "unknown_field" },
      { heading: "A", key: "evidence", value: "guess", reason: "not_an_option" },
      { heading: "A", key: "verified", value: "2026-02-30", reason: "bad_date" },
      { heading: "A", key: "status", value: "maybe", reason: "bad_status" },
    ]);
    expect(k.truncated).toBe(false);
    expect((await s.infos()).get(K1)).toMatchObject({ when: "changed", evidence: "docs", verified: "2026-10-01" });
    await s.ctx.destroy();
  });

  it("left out, status is verified when the knowledge has a last-verified date and needs-verify otherwise", async () => {
    const s = await setup([P("p1", "x")]);
    const k = (await written(s, `## Dated\n${comment(["verified: 2026-11-01"])}\n\nx\n\n## Undated\n${comment(["when: w"])}\n\ny\n`))!;
    const md = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: { authorization: `Bearer ${s.pat.token}` } })).json() as { markdown: string };
    expect(md.markdown).toContain(`id: ${k.created[0]!.id}\nverified: 2026-11-01\nstatus: verified`);
    expect(md.markdown).toContain(`id: ${k.created[1]!.id}\nwhen: w\nstatus: needs-verify`);
    await s.ctx.destroy();
  });

  it("a comment without a blank line after the --> is refused", async () => {
    const s = await setup([P("p1", "x")]);
    const r = await s.edit({ op: "append", markdown: `## B\n${comment(["when: w"])}\ntext right below\n` });
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "B" needs a blank line after its -->. Nothing was written.' });
    await s.ctx.destroy();
  });

  it("a heading whose level you changed gets nothing from the heading it replaced, and is listed in removed for the old one", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const sec = await s.section("hA");
    const k = knowledgeOf(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: "### A\n\nbody\n" }))!;
    expect(k.kept).toEqual([]);
    expect(k.removed).toEqual([{ id: K1, heading: "A" }]);
    await s.ctx.destroy();
  });
});
