/**
 * #387: a wikilink without custom text (showing the target's current title): after the agent reads it the target is renamed, and when the agent writes back with
 * `edit_note` (or `create_note`) using the text it read, the link must not freeze into custom text (`notes/editing/shown-link-texts.ts`). The batch write-back equivalent
 * is #385 (`transfer-write-linklabel.test.ts`).
 *
 * The scene seeds links with `seedBlocks` (not through a write): writes are also recorded under the writer, so seeding with `edit_note` would let the tests pass without
 * reading and no longer guard "reads are recorded".
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { ShownLinkTexts } from "../src/notes/editing/shown-link-texts.js";
import { buildCollabTestApp } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { loadDoc } from "./copy-helpers.js";
import { seedBlocks } from "./bulk-transfer-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  const result = res.json().result as { isError?: true; structuredContent: Record<string, unknown> };
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent;
}
async function readTop(app: FastifyInstance, token: string, noteId: string): Promise<{ markdown: string; fingerprint: string }> {
  const r = (await call(app, token, "read_note_section", { note_id: noteId, section_id: "_top" })) as { section: { markdown: string; fingerprint: string } };
  return r.section;
}
type Wl = { targetNoteId: string; label: string; snapshotTitle: string };
async function links(ctx: Awaited<ReturnType<typeof buildCollabTestApp>>, noteId: string): Promise<Wl[]> {
  const doc = await loadDoc(ctx.db, noteId);
  const out: Wl[] = [];
  if (doc === null) return out; // a note whose content was never written has no note_states row
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) {
    const a = (n as Y.XmlElement).getAttributes() as Partial<Wl>;
    out.push({ targetNoteId: a.targetNoteId ?? "", label: a.label ?? "", snapshotTitle: a.snapshotTitle ?? "" });
  }
  return out;
}

async function scene(extra: unknown[] = [], opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
  const target = await ctx.createNote(owner.id, "Target v1");
  const host = await ctx.createNote(owner.id, "Host");
  const href = `/notes/${target.id}`;
  // Seeded directly (neither a write nor a read): afterwards the owner has neither read nor written any link.
  await seedBlocks(ctx.db, host.id, [
    { type: "paragraph", content: [{ type: "text", text: "Para links ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Target v1", label: "" } }, { type: "text", text: " here.", styles: {} }] },
    ...extra,
  ]);
  const rename = (title: string) => ctx.db.update(notes).set({ title }).where(eq(notes.id, target.id));
  return { ctx, owner, token, target, host, href, rename };
}

describe("#387 edit_note keeps a wikilink without custom text when writing back", () => {
  it("read -> target renamed -> replace_section with the old fingerprint and the link text untouched -> label stays empty, snapshotTitle is the current title; a later rename still follows", async () => {
    const s = await scene();
    expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([""]);
    const read = await readTop(s.ctx.app, s.token, s.host.id);
    expect(read.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    // Renaming the target doesn't change this note's fingerprint, so the old fingerprint still passes.
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
    expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para edited links [Target v2](${s.href}) here.`);
    await s.rename("Target v3");
    expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para edited links [Target v3](${s.href}) here.`);
  });

  it("agent changes the link text to another word (target also renamed after the read) -> stored as custom text; changing to an old name never seen in a read also counts as custom", async () => {
    for (const text of ["My own words", "Target v0"]) {
      const s = await scene();
      const read = await readTop(s.ctx.app, s.token, s.host.id);
      await s.rename("Target v2");
      await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("[Target v1]", `[${text}]`) });
      expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([text]);
      await s.rename("Target v3");
      expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para links [${text}](${s.href}) here.`);
    }
  });

  it("insert_after, append (into another note) and replace_all writing links with the text as read -> none has custom text", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const read = await readTop(s.ctx.app, s.token, s.host.id);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "insert_after", section_id: "_top", if_match: read.fingerprint, markdown: `# Copied\n\nCopy [Target v1](${s.href})` });
    const appended = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual([""]);
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: appended.fingerprint, markdown: `All [Target v1](${s.href}) and [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v1"], ["", "Target v2"]]);
    expect((await links(s.ctx, other.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v2"], ["", "Target v2"]]);
  });

  it("what is recorded is what each person read: someone who never read it -> still stored as custom text; a read via REST GET /content counts too", async () => {
    const s = await scene();
    const restReader = await s.ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const stranger = await s.ctx.createUser({ email: `s-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.target.id, restReader.id, "viewer");
    await s.ctx.share(s.target.id, stranger.id, "viewer");
    await s.ctx.share(s.host.id, restReader.id, "editor");
    await s.ctx.share(s.host.id, stranger.id, "editor");
    const { token: restToken } = await seedTokenForUser(s.ctx.db, restReader.id, "notes:read notes:write");
    const { token: strangerToken } = await seedTokenForUser(s.ctx.db, stranger.id, "notes:read notes:write");
    await readTop(s.ctx.app, s.token, s.host.id); // the owner has read it; doesn't count for anyone else
    const rest = await getContent(s.ctx.app, s.host.id, restToken);
    expect(rest.statusCode).toBe(200);
    expect((rest.json() as { markdown: string }).markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, strangerToken, "edit_note", { note_id: s.host.id, op: "append", markdown: `Stranger [Target v1](${s.href})` });
    await call(s.ctx.app, restToken, "edit_note", { note_id: s.host.id, op: "append", markdown: `Rest [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual(["", "Target v1", ""]);
  });

  it("custom-text link read for the same target and same text -> written back it is still that custom text (the last read counts)", async () => {
    const s = await scene();
    await readTop(s.ctx.app, s.token, s.host.id); // records (target, "Target v1") as having no custom text
    await s.rename("Target v2");
    const custom = await s.ctx.createNote(s.owner.id, "Custom");
    await seedBlocks(s.ctx.db, custom.id, [
      { type: "paragraph", content: [{ type: "text", text: "Old name ", styles: {} }, { type: "wikilink", props: { targetNoteId: s.target.id, snapshotTitle: "Target v1", label: "Target v1" } }] },
    ]);
    const read = await readTop(s.ctx.app, s.token, custom.id);
    expect(read.markdown).toContain(`[Target v1](${s.href})`);
    await call(s.ctx.app, s.token, "edit_note", { note_id: custom.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Old name", "Old name kept") });
    expect((await links(s.ctx, custom.id)).map(l => l.label)).toEqual(["Target v1"]);
  });

  it("create_note content writes links with the text as read -> no custom text", async () => {
    const s = await scene();
    await readTop(s.ctx.app, s.token, s.host.id);
    await s.rename("Target v2");
    const r = (await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` })) as { note: { id: string } };
    expect(await links(s.ctx, r.note.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("a link the agent appended itself (never read) -> target renamed -> replace_all with the returned fingerprint writes it back unchanged -> still no custom text", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const a = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Mine [Target v1](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual([""]);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: a.fingerprint, markdown: `Mine edited [Target v1](${s.href})` });
    expect(await links(s.ctx, other.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("a link written by create_note (never read) -> target renamed -> the same text appended to another note -> no custom text (the create path)", async () => {
    const s = await scene();
    await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` });
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "append", markdown: `Again [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v1"], ["", "Target v2"]]);
  });

  it("REST POST /edits with an old fingerprint 409 -> target renamed -> write back per `current` -> still no custom text", async () => {
    const s = await scene();
    const stale = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.host.id}/edits`, headers: bearer(s.token), payload: { op: "replace_all", markdown: "x", if_match: "0000000000000000" } });
    expect(stale.statusCode).toBe(409);
    const current = (stale.json() as { current: { markdown: string; fingerprint: string } }).current;
    expect(current.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_all", if_match: current.fingerprint, markdown: current.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("REST undo 409 stale `current` -> target renamed -> write back per `current` -> still no custom text", async () => {
    const s = await scene([{ type: "heading", props: { level: 2 }, content: "Tail" }]);
    // Another editor makes an edit that is later changed (his reads and writes are recorded under himself and don't count for the owner).
    const writer = await s.ctx.createUser({ email: `w-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.host.id, writer.id, "editor");
    const { token: wt } = await seedTokenForUser(s.ctx.db, writer.id, "notes:read notes:write");
    const added = (await call(s.ctx.app, wt, "edit_note", { note_id: s.host.id, op: "append", markdown: "Extra" })) as { editId: string; outline: { sections: Array<{ sectionId: string; heading: string; fingerprint: string }> } };
    const tail = added.outline.sections.find(x => x.heading === "Tail")!;
    await call(s.ctx.app, wt, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: tail.sectionId, if_match: tail.fingerprint, markdown: "## Tail\n\nExtra changed" });
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.host.id}/edits/${added.editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(409);
    expect((rv.json() as { error: { code: string } }).error.code).toBe("stale");
    const current = (rv.json() as { current: { markdown: string; fingerprint: string } }).current;
    expect(current.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_all", if_match: current.fingerprint, markdown: current.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("a custom-text link the agent wrote itself -> replace_all with the returned fingerprint writes it back unchanged -> still that custom text", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const a = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Mine [My own words](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["My own words"]);
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: a.fingerprint, markdown: `Mine edited [My own words](${s.href})` });
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["My own words"]);
  });

  it("a write that fails before the merge is not recorded: edit_note append fails -> target renamed -> the same text written again -> stored as custom text as before", async () => {
    let failNext = true;
    const s = await scene([], { editingTestHooks: { beforeMerge: async () => { if (failNext) { failNext = false; throw new Error("probe: merge refused"); } } } });
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const res = await mcpPost(s.ctx.app, rpc("tools/call", { name: "edit_note", arguments: { note_id: other.id, op: "append", markdown: `Mine [Target v1](${s.href})` } }), { token: s.token });
    expect((res.json().result as { isError?: true }).isError).toBe(true);
    expect(await links(s.ctx, other.id)).toEqual([]);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` });
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["Target v1"]);
  });

  it("original text cleared on write-back also gets its expiry extended with the write (edit_note and create_note)", async () => {
    for (const via of ["edit_note", "create_note"] as const) {
      let now = 0;
      const shownLinks = new ShownLinkTexts({ ttlMs: 1000, now: () => now });
      const s = await scene([], { shownLinks });
      const read = await readTop(s.ctx.app, s.token, s.host.id); // records (target, "Target v1"), expires at 1000
      await s.rename("Target v2");
      now = 900; // write back the text as read (cleared to no custom text): the original text's expiry must be extended to 1900
      if (via === "edit_note") {
        await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Para links", "Para edited links") });
        expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([""]);
      } else {
        const made = (await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` })) as { note: { id: string } };
        expect((await links(s.ctx, made.note.id)).map(l => l.label)).toEqual([""]);
      }
      now = 1500; // the entry from the read has expired; only the one recorded by the write remains
      const other = await s.ctx.createNote(s.owner.id, "Other");
      await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` });
      expect((await links(s.ctx, other.id)).map(l => l.label), via).toEqual([""]);
    }
  });
});
