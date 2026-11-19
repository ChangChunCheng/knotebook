import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE } from "@knotebook/shared";
import { loadConfig } from "../src/config.js";
import { noteAiEdits, noteStates, notes } from "../src/db/schema.js";
import { logNotesOverCap } from "../src/notes/note-size-startup.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, signTestSession, testConfig, testEditingRuntime } from "./helpers.js";
import { bearer, docText, getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkGet, bulkPut, callTool, downloadNote, editBody, issueBulkDirect, seedMd } from "./bulk-transfer-helpers.js";

const CAP = 20_000;
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: testConfig.appSecret, PUBLIC_URL: "http://localhost:3000", NOTE_MAX_BYTES: String(CAP) });
const PASSWORD = "correct-horse-battery";
// Only growth is blocked; browser collab updates are not size-checked on the server; over-cap notes stay readable and downloadable.
/** n distinct paragraphs (about 60 bytes of text each; about 270 bytes of stored state each). */
const paras = (n: number, tag = "p") => Array.from({ length: n }, (_, k) => `${tag} ${k} lorem ipsum dolor sit amet consectetur adipiscing elit`).join("\n\n");
const BIG = paras(450); // state about 120 KB: over CAP
const SMALL = paras(20); // about 5 KB

async function scene() {
  const ctx = await buildCollabTestApp({ config });
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "N" });
  const stored = async (id = note.id) => {
    const [r] = await ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, id));
    return r ? r.ydoc.byteLength : 0;
  };
  const edit = (payload: Record<string, unknown>, id = note.id) => ctx.app.inject({ method: "POST", url: `/api/notes/${id}/edits`, headers: bearer(pat.token), payload });
  return { ctx, u, pat, note, stored, edit };
}
const expect413 = (res: { statusCode: number; json(): unknown }) => {
  expect(res.statusCode).toBe(413);
  expect((res.json() as { error: { code: string; limitBytes: number } }).error).toMatchObject({ code: "note_too_large", limitBytes: CAP });
};

describe("API/MCP writes: refused when over the cap, nothing written", () => {
  it("REST /edits append pushing a note over the cap -> 413 (limitBytes), content and records untouched; within the cap still 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    expect((await s.edit({ op: "append", markdown: paras(30, "ok") })).statusCode).toBe(201);
    const before = await s.stored();
    const res = await s.edit({ op: "append", markdown: paras(400, "big") });
    expect413(res);
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    expect(c.markdown).not.toContain("big 0 ");
    expect(await s.stored()).toBe(before);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(1);
    await s.ctx.destroy();
  });

  it("MCP edit_note -> tool error note_too_large (with limitBytes)", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "append", markdown: paras(400, "big") });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    await s.ctx.destroy();
  });

  it("create with content (REST POST /api/notes, MCP create_note) over the cap -> 413/note_too_large, no row left behind", async () => {
    const s = await scene();
    const count = async () => (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const n0 = await count();
    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.pat.token), payload: { title: "big", content: BIG } });
    expect413(res);
    const r = await callTool(s.ctx.app, s.pat.token, "create_note", { title: "big", content: BIG });
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    expect(await count()).toBe(n0);
    const ok = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.pat.token), payload: { title: "small", content: SMALL } });
    expect(ok.statusCode).toBe(201);
    await s.ctx.destroy();
  });

  it("batch write-back (one section made huge) -> 413; batch creating a huge file -> 413, not created", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    const d = await downloadNote(s.ctx.app, bulk.token, s.note.id);
    const before = await s.stored();
    const r = await bulkPut(s.ctx.app, bulk.token, editBody(d.text, b => b + "\n\n" + paras(400, "big")));
    expect(r.statusCode, r.body).toBe(413);
    expect(r.json().error).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    expect(await s.stored()).toBe(before);
    const c = await bulkPut(s.ctx.app, bulk.token, `---\nknotebook: 1\ntitle: "new big"\n---\n${BIG}\n`);
    expect(c.statusCode, c.body).toBe(413);
    expect((await s.ctx.db.select().from(notes).where(eq(notes.title, "new big")))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("revert that undoes a section deletion (re-inserts the big section) would exceed the cap -> 413; the deletion itself (shrinking) is accepted", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(40, "a") + "\n\n# B\n\nb");
    const outline = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>;
    const a = outline.find(o => o.heading === "A")!;
    const del = await s.edit({ op: "delete_section", section_id: a.sectionId, if_match: a.fingerprint });
    expect(del.statusCode, del.body).toBe(201);
    // Another section grows close to full: re-inserting section A then exceeds the cap
    const fill = await s.edit({ op: "append", markdown: paras(40, "fill") }); // about 11 KB: still within the cap
    expect(fill.statusCode, fill.body).toBe(201);
    const rev = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${del.json().editId}/revert`, headers: bearer(s.pat.token) });
    expect413(rev);
    await s.ctx.destroy();
  });

  it("copying a note already over the cap -> 413 (the copy is a new note: larger than 0 and over the cap); within the cap copies normally", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG);
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/copy`, headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" }, payload: {} });
    expect413(res);
    const r = await callTool(s.ctx.app, s.pat.token, "copy_note", { note_id: s.note.id });
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    const small = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "S" });
    await seedMd(s.ctx.db, small.id, SMALL);
    const ok = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${small.id}/copy`, headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" }, payload: {} });
    expect(ok.statusCode, ok.body).toBe(201);
    await s.ctx.destroy();
  });

  it("applying (restoring) a version larger than the current state and over the cap -> 413; current state untouched", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG); // already over the cap (a note that existed before the cap)
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    const saved = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions`, headers, payload: {} });
    expect(saved.statusCode, saved.body).toBe(201);
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    const shrink = await s.edit({ op: "replace_all", markdown: "small now", if_match: c.fingerprint }); // shrinks: accepted
    expect(shrink.statusCode, shrink.body).toBe(201);
    const after = await s.stored();
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions/${saved.json().seq}/apply`, headers, payload: { versionId: saved.json().id, discardUnsaved: true } });
    expect413(res);
    expect((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().markdown).toContain("small now");
    expect(await s.stored()).toBe(after);
    await s.ctx.destroy();
  });
});

describe("notes already over the cap: still readable and downloadable; deleting and shortening are accepted", () => {
  it("over-cap note: /content, read_note_section and single download all 200; deleting a section and replacing the whole note with a short one -> 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(220, "a") + "\n\n# B\n\n" + paras(220, "b"));
    expect(await s.stored()).toBeGreaterThan(CAP);
    const c = await getContent(s.ctx.app, s.note.id, s.pat.token);
    expect(c.statusCode).toBe(200);
    const sec = await callTool(s.ctx.app, s.pat.token, "read_note_section", { note_id: s.note.id, section_id: "_top" });
    expect(sec.isError).toBeUndefined();
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    expect((await bulkGet(s.ctx.app, `/api/transfer/notes/${s.note.id}`, bulk.token)).statusCode).toBe(200);
    // Still above the cap but smaller: accepted
    const b = (c.json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const del = await s.edit({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint });
    expect(del.statusCode, del.body).toBe(201);
    // A note above the cap can't grow again (even by a little)
    expect413(await s.edit({ op: "append", markdown: "one more line" }));
    const now = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    const short = await s.edit({ op: "replace_all", markdown: "short", if_match: now.fingerprint });
    expect(short.statusCode, short.body).toBe(201);
    await s.ctx.destroy();
  });
});

describe("browser collab updates aren't checked on the server (the web editor blocks before paste, drop and in-site AI apply)", () => {
  it("collab client pastes a big chunk pushing the note over the cap -> server applies it as usual and relays it to the other client, the connection isn't closed", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await ctx.createUser({ email: "c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("c@example.com", PASSWORD);
    const a = await session.connect(note.id);
    const b = await session.connect(note.id);
    const s = await EditorSession.open(testEditingRuntime, a.doc);
    try {
      const top = s.editor.document;
      s.editor.insertBlocks(paras(400, "huge").split("\n\n").map(t => ({ type: "paragraph", content: t })), top[top.length - 1]!.id, "after");
    } finally {
      s.close();
    }
    expect(Y.encodeStateAsUpdate(a.doc).byteLength).toBeGreaterThan(CAP);
    await waitFor("server 與 b 收到", 10_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("huge 399 ") && docText(b.doc).includes("huge 399 "));
    expect(a.closes).toHaveLength(0);
    a.disconnect();
    b.disconnect();
    await ctx.destroy();
  }, 60_000);
});

describe("shrinking and same-size rewrites are always accepted (judged by result: remaining content didn't grow, state grows at most SLACK at once)", () => {
  it("over-cap note: rewriting a section to shorter text (state may grow from structure cost) -> REST 201, MCP also succeeds", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(220, "a") + "\n\n# B\n\nhello wonderful world");
    expect(await s.stored()).toBeGreaterThan(CAP);
    const b = ((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const res = await s.edit({ op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nhello world", if_match: b.fingerprint });
    expect(res.statusCode, res.body).toBe(201);
    const b2 = ((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "replace_section", section_id: b2.sectionId, markdown: "# B\n\nhi", if_match: b2.fingerprint });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    await s.ctx.destroy();
  });

  it("a copy blocked by 413 doesn't consume edit quota: after 35 consecutive blocks, a within-cap copy still gives 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG);
    const small = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "S" });
    await seedMd(s.ctx.db, small.id, SMALL);
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    for (let i = 0; i < 35; i++) expect413(await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/copy`, headers, payload: {} }));
    const ok = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${small.id}/copy`, headers, payload: {} });
    expect(ok.statusCode, ok.body).toBe(201);
    await s.ctx.destroy();
  });
});

describe("startup log", () => {
  it("logs the notes already over the cap: count and ids (not titles); logs 0 if none", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const big = await seedNote(ctx.db, { ownerId: u.id }, { title: "秘密標題" });
    const small = await seedNote(ctx.db, { ownerId: u.id }, { title: "S" });
    await seedMd(ctx.db, big.id, BIG);
    await seedMd(ctx.db, small.id, SMALL);
    const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
    const log = { info: (obj: object, msg: string) => lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }), warn: (obj: object, msg: string) => lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }) };
    const r = await logNotesOverCap(ctx.db, CAP, log);
    expect(r).toEqual({ count: 1, noteIds: [big.id] });
    expect(lines).toEqual([{ level: "warn", obj: { limitBytes: CAP, count: 1, noteIds: [big.id] }, msg: expect.stringContaining("over the note size limit") }]);
    expect(JSON.stringify(lines)).not.toContain("秘密標題");
    lines.length = 0;
    expect(await logNotesOverCap(ctx.db, 10 * CAP, log)).toEqual({ count: 0, noteIds: [] });
    expect(lines[0]).toMatchObject({ level: "info", obj: { limitBytes: 10 * CAP, count: 0 } });
    await ctx.destroy();
  });
});
