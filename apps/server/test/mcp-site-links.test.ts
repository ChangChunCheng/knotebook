import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { loadDoc, seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  const result = res.json().result as { isError?: true; structuredContent: Record<string, unknown> };
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent;
}
async function topMarkdown(app: FastifyInstance, token: string, noteId: string): Promise<string> {
  const r = (await call(app, token, "read_note_section", { note_id: noteId, section_id: "_top" })) as { section: { markdown: string } };
  return r.section.markdown;
}
function wikilinkAttrs(doc: Y.Doc): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) {
    out.push((n as Y.XmlElement).getAttributes());
  }
  return out;
}

describe("#269: MCP internal link round trip", () => {
  it("writing [x](/g/<gid>/<slug>#b-<bid>) reads back [x](/notes/<id>#b-<bid>); with an empty label, after the target is renamed the new title reads back; same in tables; REST /content has the same shape", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const group = await seedGroup(ctx.db, "G", [{ userId: owner.id, role: "admin" }]);
    const gnote = await seedNote(ctx.db, { groupId: group.id }, { title: "Group Doc", slug: "group-doc" });
    const target = await ctx.createNote(owner.id, "Target");
    const host = await ctx.createNote(owner.id, "Host");

    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[x](/g/${group.id}/group-doc#b-abc123)` });
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[Target](${testConfig.publicUrl.origin}/notes/${target.id})` });
    // Two table cells: one with a non-empty label (cell), one with an empty label (text = title): "read back the new title after a rename" also needs integration-level observation in tables.
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `| a | b |\n| --- | --- |\n| [cell](/notes/${target.id}) | [Target](/notes/${target.id}) |` });
    const count = (s: string, sub: string) => s.split(sub).length - 1;

    let md = await topMarkdown(ctx.app, token, host.id);
    expect(md).toContain(`[x](/notes/${gnote.id}#b-abc123)`);
    expect(count(md, `[Target](/notes/${target.id})`)).toBe(2); // paragraph + table
    expect(md).toContain(`[cell](/notes/${target.id})`);

    await ctx.db.update(notes).set({ title: "Renamed" }).where(eq(notes.id, target.id));
    md = await topMarkdown(ctx.app, token, host.id);
    expect(count(md, `[Renamed](/notes/${target.id})`)).toBe(2); // empty label => current title (both paragraph and table cell)
    expect(md).not.toContain(`[Target](/notes/${target.id})`);
    expect(md).toContain(`[cell](/notes/${target.id})`); // non-empty label => unchanged

    const rest = await getContent(ctx.app, host.id, token);
    expect(rest.statusCode).toBe(200);
    expect((rest.json() as { markdown: string }).markdown).toContain(`[Renamed](/notes/${target.id})`);
  });

  it("reader can't see the target: reads back snapshotTitle, doesn't reveal the current title; after write-back it becomes an ordinary link", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const reader = await ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const { token: readerToken } = await seedTokenForUser(ctx.db, reader.id, "notes:read notes:write");
    const secret = await ctx.createNote(owner.id, "Secret Title");
    const host = await ctx.createNote(owner.id, "Host");
    await ctx.share(host.id, reader.id, "editor");
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[Secret Title](/notes/${secret.id})` });
    // A target the reader can't see inside a table cell likewise reads back the stored text.
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `| s |\n| --- |\n| [Secret Title](/notes/${secret.id}) |` });
    await ctx.db.update(notes).set({ title: "Renamed Secret" }).where(eq(notes.id, secret.id));
    const count = (s: string, sub: string) => s.split(sub).length - 1;

    const md = await topMarkdown(ctx.app, readerToken, host.id);
    expect(count(md, `[Secret Title](/notes/${secret.id})`)).toBe(2); // paragraph + table cell
    expect(md).not.toContain("Renamed Secret");
    // Control: the owner can see it => the same document reads back the current title (proves the two lines above aren't from nothing having been replaced).
    expect(count(await topMarkdown(ctx.app, token, host.id), `[Renamed Secret](/notes/${secret.id})`)).toBe(2);

    // REST reads also take the title from the **reader's** visibility: `/content` and the `current` of a `/edits` 409.
    const rest = await getContent(ctx.app, host.id, readerToken);
    expect(rest.statusCode).toBe(200);
    const restMd = (rest.json() as { markdown: string }).markdown;
    expect(count(restMd, `[Secret Title](/notes/${secret.id})`)).toBe(2);
    expect(restMd).not.toContain("Renamed Secret");
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/notes/${host.id}/edits`,
      headers: bearer(readerToken),
      payload: { op: "replace_all", markdown: "x", if_match: "0000000000000000" },
    });
    expect(stale.statusCode).toBe(409);
    const currentMd = (stale.json() as { current: { markdown: string } }).current.markdown;
    expect(count(currentMd, `[Secret Title](/notes/${secret.id})`)).toBe(2);
    expect(currentMd).not.toContain("Renamed Secret");

    await call(ctx.app, readerToken, "edit_note", { note_id: host.id, op: "append", markdown: `[again](/notes/${secret.id})` });
    const doc = (await loadDoc(ctx.db, host.id))!;
    expect(wikilinkAttrs(doc)).toHaveLength(2); // the owner's paragraph + table make two; the reader's one can't be seen => an ordinary link
  });

  it("titles and labels containing markdown special characters - escaping is right on read, and the label is identical on write-back (or empty when the text = the title)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const tricky = await ctx.createNote(owner.id, "[Draft] Plan *v2*");
    const src = await ctx.createNote(owner.id, "Src");
    const dst = await ctx.createNote(owner.id, "Dst");
    // An empty label (text = title), and a label containing `]` and a backslash.
    await call(ctx.app, token, "edit_note", { note_id: src.id, op: "append", markdown: `[\\[Draft\\] Plan \\*v2\\*](/notes/${tricky.id}) [a\\]b\\\\](/notes/${tricky.id})` });
    const before = wikilinkAttrs((await loadDoc(ctx.db, src.id))!);
    expect(before.map(a => a.label ?? "")).toEqual(["", "a]b\\"]);

    const md = await topMarkdown(ctx.app, token, src.id);
    await call(ctx.app, token, "edit_note", { note_id: dst.id, op: "append", markdown: md });
    const after = wikilinkAttrs((await loadDoc(ctx.db, dst.id))!);
    expect(after.map(a => a.label ?? "")).toEqual(["", "a]b\\"]);
    expect(after.map(a => a.targetNoteId)).toEqual([tricky.id, tricky.id]);
  });

  // Old documents may store an uppercase targetNoteId while the DB returns lowercase ids: the current-title lookup must be case-insensitive, otherwise it falls back to snapshotTitle.
  it("document stores an uppercase targetNoteId: MCP still reads the current title (not snapshotTitle)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const target = await ctx.createNote(owner.id, "Live Title");
    const host = await ctx.createNote(owner.id, "Host");
    const upper = target.id.toUpperCase();
    expect(upper).not.toBe(target.id); // fixture self-check: the id really has letters a-f that get uppercased
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", "m1");
    const p = new Y.XmlElement("paragraph");
    const w = new Y.XmlElement("wikilink");
    w.setAttribute("targetNoteId", upper);
    w.setAttribute("snapshotTitle", "Old Snapshot");
    const t = new Y.XmlText();
    p.insert(0, [t, w]);
    c.insert(0, [p]);
    g.insert(0, [c]);
    t.insert(0, "see ");
    await seedDoc(ctx.db, host.id, doc);

    const md = await topMarkdown(ctx.app, token, host.id);
    expect(md).toContain(`[Live Title](/notes/${upper})`);
    expect(md).not.toContain("Old Snapshot");
  });

  // `createWithContent`'s write transform (visible list + siteOrigin) had no integration-level observation.
  it("internal links in create_note's content -> stored as wikilinks (same rule as edit_note)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const target = await ctx.createNote(owner.id, "Target");
    const r = (await call(ctx.app, token, "create_note", { title: "Made", content: `see [Target](${testConfig.publicUrl.origin}/notes/${target.id}#b-h1)` })) as { note: { id: string } };
    const attrs = wikilinkAttrs((await loadDoc(ctx.db, r.note.id))!);
    expect(attrs.map(a => [a.targetNoteId, a.label ?? "", a.anchorBlockId ?? ""])).toEqual([[target.id, "", "h1"]]);
  });
});
