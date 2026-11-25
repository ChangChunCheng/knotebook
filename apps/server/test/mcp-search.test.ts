import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedIndexedNote, waitIndexed } from "./search-helpers.js";
import { SEARCH_NOTES_DESCRIPTION_NO_READ, SEARCH_NOTES_DESCRIPTION_READ } from "../src/mcp/tools/search-notes.js";

const PASSWORD = "correct-horse-battery";
type Hit = { id: string; matchedOn: string; matches: Array<{ sectionId: string; heading: string; headingTruncated?: true; snippet: string }> } & Record<string, unknown>;

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { isError?: true; content: { text: string }[]; structuredContent: Record<string, unknown> };
  expect(result.isError).toBeUndefined();
  expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
const hitsOf = (p: Record<string, unknown>) => p.notes as Hit[];

type Described = { description?: string };
type MatchSchema = { properties: { sectionId: Described } };
type HitSchema = { properties: { matchedOn: Described; matches: Described & { items: MatchSchema } } };
interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: { query: Described; terms: Described & { enum: string[] } } };
  outputSchema: { properties: { notes: { items: HitSchema }; matchesTruncated: Described } };
}

async function toolsList(app: FastifyInstance, token: string) {
  const res = await mcpPost(app, rpc("tools/list"), { token });
  expect(res.statusCode).toBe(200);
  return { body: res.body, tools: res.json().result.tools as ListedTool[] };
}

describe("verbatim descriptions (two deployment shapes)", () => {
  it("with collab (read tools present): description, query and sectionId descriptions are verbatim; the old sentence is absent", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: `m8-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const { body, tools } = await toolsList(ctx.app, token);
    const t = tools.find(x => x.name === "search_notes")!;
    expect(t.description).toBe(SEARCH_NOTES_DESCRIPTION_READ);
    expect(SEARCH_NOTES_DESCRIPTION_READ).toBe(
      "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. Separate keywords with spaces (there is no word segmentation, so CJK keywords need spaces too) and put a phrase in double quotes; up to 8 keywords. By default a note must contain every keyword, each in its title or body; set `terms` to `any` to match any of them. Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body; with several keywords, notes containing more of them come first. A body match lists up to 3 sections, those containing the most keywords first and then in document order, each with an excerpt near the first hit; pass a `sectionId` to read_note_section. `matches` can be empty for a body match; read the note's outline then. Saved changes are usually searchable within seconds, but right after an upgrade older notes may match by title only for a while. Attachments are not searched.",
    );
    expect(t.inputSchema.properties.query.description).toBe("Keywords to look for in note titles and body text, separated by spaces; a phrase in double quotes is one keyword. Matched literally — `%` and `_` are not wildcards.");
    expect(t.inputSchema.properties.terms).toMatchObject({ enum: ["all", "any"], description: "`all` (default): a note must contain every keyword. `any`: at least one, notes with more keywords first." });
    const item = t.outputSchema.properties.notes.items.properties;
    expect(item.matches.items.properties.sectionId.description).toBe("Pass this to read_note_section.");
    expect(item.matchedOn.description).toBe("Whether your text was found in the title, the body, or both.");
    expect(t.outputSchema.properties.matchesTruncated.description).toBe("Present when some matches were left out to keep this reply small. Ask for fewer notes with `limit`.");
    expect(body).not.toContain("Searches note titles only");
  });

  it("without collab: description and sectionId descriptions are another version, not containing read_note_section / outline / seconds", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const { tools } = await toolsList(app, token);
    const t = tools.find(x => x.name === "search_notes")!;
    expect(t.description).toBe(SEARCH_NOTES_DESCRIPTION_NO_READ);
    expect(SEARCH_NOTES_DESCRIPTION_NO_READ).toBe(
      "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. Separate keywords with spaces (there is no word segmentation, so CJK keywords need spaces too) and put a phrase in double quotes; up to 8 keywords. By default a note must contain every keyword, each in its title or body; set `terms` to `any` to match any of them. Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body; with several keywords, notes containing more of them come first. A body match lists up to 3 sections, those containing the most keywords first and then in document order, each with an excerpt near the first hit; `matches` can be empty for a body match. Attachments are not searched.",
    );
    for (const banned of ["read_note_section", "outline", "seconds"]) expect(t.description).not.toContain(banned);
    expect(t.outputSchema.properties.notes.items.properties.matches.items.properties.sectionId.description).toBe("The section's id.");
  });
});

describe("MCP layer", () => {
  it("matchedOn takes three values; with title the matches is empty; top-level keys are exactly notes and truncated, with no cursor / top-level matchedOn", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const title = await seedNote(db, { ownerId: u.id }, { title: "sigma only title" });
    const both = await seedIndexedNote(db, { ownerId: u.id }, "sigma both", [{ id: "p", text: "sigma in body" }]);
    const body = await seedIndexedNote(db, { ownerId: u.id }, "unrelated", [{ id: "p", text: "and sigma here" }]);
    const p = await call(app, token, "search_notes", { query: "sigma" });
    expect(Object.keys(p).sort()).toEqual(["notes", "truncated"]);
    const byId = new Map(hitsOf(p).map(h => [h.id, h]));
    expect(byId.get(title.id)).toMatchObject({ matchedOn: "title", matches: [] });
    expect(byId.get(both.id)!.matchedOn).toBe("both");
    expect(byId.get(both.id)!.matches).toHaveLength(1);
    expect(byId.get(body.id)!.matchedOn).toBe("body");
    expect(hitsOf(p).map(h => h.id).at(-1)).toBe(body.id);
    expect(JSON.stringify(p)).not.toMatch(/"(next)?[cC]ursor"/);
  });
});

describe("matches connect to read_note_section", () => {
  it("at most 3, in document order; the sectionId can be read and contains the matched word; the heading equals the outline's for the same section", async () => {
    const ctx = await buildCollabTestApp();
    const email = `m3-${randomUUID()}@example.com`;
    const u = await ctx.createUser({ email, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const note = await ctx.createNote(u.id, "zeta host");
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# Alpha\n\nfoo zeta one\n\n# Beta\n\nbar\n\n# Gamma\n\nzeta two\n\n# Delta\n\nzeta three\n\n# Eps\n\nzeta four");
    client.disconnect();
    await waitIndexed(ctx.db, note.id, b => b.includes("zeta four"));
    const hit = hitsOf(await call(ctx.app, token, "search_notes", { query: "ZETA" })).find(h => h.id === note.id)!;
    expect(hit.matchedOn).toBe("both");
    expect(hit.matches.map(m => m.heading)).toEqual(["Alpha", "Gamma", "Delta"]);
    const outline = (await call(ctx.app, token, "read_note_outline", { note_id: note.id })).sections as Array<{ sectionId: string; heading: string }>;
    for (const m of hit.matches) {
      expect(outline.find(o => o.sectionId === m.sectionId)?.heading).toBe(m.heading);
      const sec = await call(ctx.app, token, "read_note_section", { note_id: note.id, section_id: m.sectionId });
      expect((sec.section as { markdown: string }).markdown.toLowerCase()).toContain("zeta");
      expect(m.snippet.toLowerCase()).toContain("zeta");
    }
  });
});

describe("end to end", () => {
  it("40 U+0001 as the prefix + a match -> the excerpt contains the whole match, at most 160 after escaping", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const n = await seedIndexedNote(db, { ownerId: u.id }, "c0", [{ id: "p", text: `${"\u0001".repeat(40)}zeta tail` }]);
    const m = hitsOf(await call(app, token, "search_notes", { query: "zeta" })).find(h => h.id === n.id)!.matches[0]!;
    expect(m.snippet).toContain("zeta tail");
    expect(JSON.stringify(m.snippet).length - 2).toBeLessThanOrEqual(160);
  });
});

describe("#399 several keywords", () => {
  async function callError(app: FastifyInstance, token: string, args: unknown) {
    const res = await mcpPost(app, rpc("tools/call", { name: "search_notes", arguments: args }), { token });
    expect(res.statusCode).toBe(200);
    return res.json().result as { isError?: true; structuredContent: { code: string; message: string } };
  }

  it("all by default; matchedTerms on notes and sections only for several keywords; one keyword keeps the old reply shape", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const both = await seedIndexedNote(db, { ownerId: u.id }, "Deploy runbook", [{ id: "p", text: "first copy the prod database" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "deploy only", [{ id: "p", text: "nothing else" }]);
    const p = await call(app, token, "search_notes", { query: "deploy prod" });
    const hits = hitsOf(p);
    expect(hits.map(h => h.id)).toEqual([both.id]);
    expect(hits[0]).toMatchObject({ matchedOn: "both", matchedTerms: ["deploy", "prod"] });
    expect(hits[0]!.matches).toEqual([{ sectionId: "_top", heading: "", snippet: "first copy the prod database", matchedTerms: ["prod"] }]);

    const single = hitsOf(await call(app, token, "search_notes", { query: "prod" }));
    expect(single[0]).not.toHaveProperty("matchedTerms");
    expect(single[0]!.matches[0]).not.toHaveProperty("matchedTerms");
  });

  it("terms: any returns notes with any keyword, more keywords first; a quoted phrase is one keyword", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const two = await seedIndexedNote(db, { ownerId: u.id }, "a", [{ id: "p", text: "release notes and rollback" }]);
    const one = await seedIndexedNote(db, { ownerId: u.id }, "b", [{ id: "p", text: "rollback only" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "c", [{ id: "p", text: "release of the notes" }]);
    const p = await call(app, token, "search_notes", { query: '"release notes" rollback', terms: "any" });
    expect(hitsOf(p).map(h => [h.id, h.matchedTerms])).toEqual([[two.id, ["release notes", "rollback"]], [one.id, ["rollback"]]]);
  });

  it("over 8 keywords or nothing to search -> invalid_body, before the rate limiter", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    for (const query of ["a b c d e f g h i", "   "]) {
      const r = await callError(app, token, { query });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toEqual({ code: "invalid_body", message: "Give 1 to 8 keywords: separate them with spaces, or put a phrase in double quotes." });
    }
  });
});
