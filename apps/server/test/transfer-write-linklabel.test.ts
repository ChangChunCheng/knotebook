// A wikilink with no custom text displays the target's current title: after the target is renamed following a download, editing the paragraph
// that contains that link in the old copy and writing back must not freeze the link text into custom text (`transfer/link-texts.ts`).
// The last case is a copy downloaded before this version (the base has no `links`).
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notes, transferBases } from "../src/db/schema.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, seedBlocks } from "./bulk-transfer-helpers.js";

async function scene(label = "") {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "E" });
  const target = await seedNote(ctx.db, { ownerId: u.id }, { title: "Target v1" });
  await seedBlocks(ctx.db, note.id, [
    { type: "paragraph", content: [{ type: "text", text: "Para E1 links ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Old snapshot", label } }, { type: "text", text: " here.", styles: {} }] },
    { type: "paragraph", content: "Para E2" },
  ]);
  const renameTarget = (title: string) => ctx.db.update(notes).set({ title }).where(eq(notes.id, target.id));
  const links = async () => {
    const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    const s = await EditorSession.open(testEditingRuntime, doc);
    try {
      type Wl = { type: string; props?: { label: string; snapshotTitle: string } };
      return s.editor.document.flatMap(b => (Array.isArray(b.content) ? (b.content as Wl[]) : []).filter(c => c.type === "wikilink").map(c => ({ label: c.props!.label, snapshotTitle: c.props!.snapshotTitle })));
    } finally {
      s.close();
    }
  };
  /** The first paragraph as the reader sees it (download = MCP read: a link without custom text shows the target's current title). */
  const firstPara = async () => (await downloadNote(ctx.app, bulk.token, note.id)).body.split("\n").find(l => l.startsWith("Para E1"))!;
  return { ctx, u, pat, bulk, note, target, renameTarget, links, firstPara };
}
const href = (id: string) => `/notes/${id}`;

describe("write-back keeps wikilinks that have no custom text", () => {
  it("download -> target renamed -> old copy edits the paragraph containing the link (link text untouched) -> 200 applied, label still empty, shows the current title; a later rename still follows", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain(`[Target v1](${href(s.target.id)})`);
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(await s.links()).toEqual([{ label: "", snapshotTitle: "Target v2" }]);
    expect(await s.firstPara()).toBe(`Para E1 edited links [Target v2](${href(s.target.id)}) here.`);
    await s.renameTarget("Target v3");
    expect(await s.firstPara()).toBe(`Para E1 edited links [Target v3](${href(s.target.id)}) here.`);
  });

  it("agent changes the link text to custom text (target also renamed after download) -> stored as a custom label; changing it to the base's snapshotTitle also counts as custom", async () => {
    for (const text of ["My own words", "Old snapshot"]) {
      const s = await scene();
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      await s.renameTarget("Target v2");
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("[Target v1]", `[${text}]`)));
      expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
      expect((await s.links()).map(l => l.label)).toEqual([text]);
      await s.renameTarget("Target v3");
      expect(await s.firstPara()).toBe(`Para E1 links [${text}](${href(s.target.id)}) here.`);
    }
  });

  it("target not renamed, agent edits other words in the same paragraph -> label still empty; a later rename follows", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace(" here.", " over here.")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual([""]);
    await s.renameTarget("Target v2");
    expect(await s.firstPara()).toBe(`Para E1 links [Target v2](${href(s.target.id)}) over here.`);
  });

  it("link already had custom text -> target renamed, other words in the paragraph edited and written back -> the custom text is kept", async () => {
    const s = await scene("Custom words");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain(`[Custom words](${href(s.target.id)})`);
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual(["Custom words"]);
    expect(await s.firstPara()).toBe(`Para E1 edited links [Custom words](${href(s.target.id)}) here.`);
  });

  it("base paragraph table has no links (copy downloaded before this version) -> old rule: the title at download time is stored as custom text", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const [row] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!));
    expect(row!.segments!.some(sg => (sg.links?.length ?? 0) > 0)).toBe(true);
    await s.ctx.db.update(transferBases).set({ segments: row!.segments!.map(({ links: _l, ...sg }) => sg) }).where(eq(transferBases.key, d.fm.base!));
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual(["Target v1"]);
  });
});
