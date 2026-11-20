/** Model-facing strings are written as literals. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import { groups, noteAiEdits, noteRedirects, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { fingerprintOf } from "../src/notes/editing/fingerprint.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const RW = "notes:read notes:write" as const;
const FORBIDDEN = "You can read this note but not change it. Ask whoever manages your access to it for editing rights.";
const RENAME_CONFLICT =
  "The note was moved into a group, or its group was deleted, after your access was checked, so its title was not changed. Try again.";
const TOKEN_RATE_LIMITED = "Too many writes with this credential right now. Wait a few minutes before writing again.";
const INVALID_TAIL =
  "replace_section, insert_after and delete_section need `section_id`; every operation except delete_section and rename needs " +
  "`markdown`; every operation except append needs `if_match` (for rename, the title's `titleFingerprint`); rename needs `title`, " +
  "and no other operation takes it. Fields that do not belong to the operation are rejected.";
const RENAME_MISMATCH =
  "`if_match` is not the fingerprint of the note's current title — most likely the title was changed after you got that " +
  "fingerprint — so the note was not renamed. Call read_note_outline to see the current title and its `titleFingerprint`, " +
  "then retry with that as `if_match` if you still want to rename it.";
/** Well-formed but never any test title's fingerprint (for callers who can't get the real one: strangers, nonexistent notes). */
const DUMMY_FP = "0123456789abcdef";

type Result = { isError?: true; content: { text: string }[]; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };

async function call(app: FastifyInstance, auth: { token?: string; cookie?: string }, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
/** Follows the model's real flow: first `read_note_outline` with **the same credential** to get `titleFingerprint`; if it can't be read (not_found) send DUMMY_FP. Not read when `ifMatch` is given explicitly. */
async function titleFpVia(app: FastifyInstance, auth: { token?: string; cookie?: string }, noteId: string): Promise<string> {
  const o = await call(app, auth, "read_note_outline", { note_id: noteId });
  return o.isError ? DUMMY_FP : (o.structuredContent!.titleFingerprint as string);
}
const rename = async (app: FastifyInstance, token: string, noteId: string, title: string, ifMatch?: string) =>
  call(app, { token }, "edit_note", { note_id: noteId, op: "rename", title, if_match: ifMatch ?? (await titleFpVia(app, { token }, noteId)) });
const sessionCookie = async (userId: string) => (await cookieOf(userId))[SESSION_COOKIE]!;
async function row(db: Parameters<typeof seedUser>[0], id: string) {
  const [r] = await db.select().from(notes).where(eq(notes.id, id));
  return r!;
}
async function listUrl(app: FastifyInstance, token: string, id: string): Promise<string> {
  const r = await call(app, { token }, "list_notes", { limit: 100 });
  return ((r.structuredContent!.notes as Array<{ id: string; url: string }>).find(n => n.id === id))!.url;
}

describe("#180 edit_note rename", () => {
  it("happy path (personal, auto slug): response is exactly {title,titleFingerprint,url} with no isError; DB title/slug/updated_at; url same text as list_notes; old by-path 404 with no redirect row; no AI record left", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Old title", slug: "old-title" });
    const before = await row(ctx.db, n.id);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);

    // read_note_outline's titleFingerprint = fingerprintOf(the full title).
    const fp0 = await titleFpVia(ctx.app, { token }, n.id);
    expect(fp0).toBe(fingerprintOf("Old title"));
    const r = await rename(ctx.app, token, n.id, "New title", fp0);

    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent!).sort()).toEqual(["title", "titleFingerprint", "url"]);
    expect(r.structuredContent).toEqual({ title: "New title", titleFingerprint: fingerprintOf("New title"), url: `/n/${me.handle}/new-title` });
    // The new fingerprint returned on success equals the one a later re-read gets (consecutive renames needn't read back).
    expect(await titleFpVia(ctx.app, { token }, n.id)).toBe(r.structuredContent!.titleFingerprint);
    const after = await row(ctx.db, n.id);
    expect(after.title).toBe("New title");
    expect(after.slug).toBe("new-title");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(await listUrl(ctx.app, token, n.id)).toBe(r.structuredContent!.url);
    const old = await ctx.app.inject({ method: "GET", url: `/api/notes/by-path/${me.handle}/old-title`, cookies: await cookieOf(me.id) });
    expect(old.statusCode).toBe(404);
    expect(await ctx.db.select().from(noteRedirects).where(eq(noteRedirects.noteId, n.id))).toEqual([]);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id))).toEqual([]);
    const edits = await ctx.app.inject({ method: "GET", url: `/api/notes/${n.id}/edits`, cookies: await cookieOf(me.id) });
    expect(edits.statusCode).toBe(200);
    expect(edits.json().edits).toEqual([]);
  });

  it("a shared editor renames someone else's personal note -> the url uses the owner's handle", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, ed] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db)]);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Theirs" });
    await seedShare(ctx.db, n.id, ed.id, "editor");
    const { token } = await seedTokenForUser(ctx.db, ed.id, RW);
    const r = await rename(ctx.app, token, n.id, "Renamed by editor");
    expect(r.structuredContent).toEqual({ title: "Renamed by editor", titleFingerprint: fingerprintOf("Renamed by editor"), url: `/n/${owner.handle}/renamed-by-editor` });
  });

  it("a group editor renames a group note -> /g/<group id>/<slug>", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(ctx.db, { groupId: g.id }, { title: "Group note" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Group renamed");
    expect(r.structuredContent).toEqual({ title: "Group renamed", titleFingerprint: fingerprintOf("Group renamed"), url: `/g/${g.id}/group-renamed` });
  });

  it("REST PATCH {slug:'keep-me'} sets a custom slug first -> rename: slug and url unchanged, title changed", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Custom" });
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { slug: "keep-me" } })).statusCode).toBe(200);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Totally different");
    expect(r.structuredContent).toEqual({ title: "Totally different", titleFingerprint: fingerprintOf("Totally different"), url: `/n/${me.handle}/keep-me` });
    expect((await row(ctx.db, n.id)).slug).toBe("keep-me");
  });

  it("permissions: a stranger and a nonexistent note -> not_found with a body byte-identical to read_note_outline's; a viewer share and a group create-only role -> forbidden", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, stranger, viewer, creator] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db)]);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Private" });
    await seedShare(ctx.db, n.id, viewer.id, "viewer");
    const st = (await seedTokenForUser(ctx.db, stranger.id, RW)).token;
    const outline = await call(ctx.app, { token: st }, "read_note_outline", { note_id: n.id });
    const a = await rename(ctx.app, st, n.id, "x");
    const b = await rename(ctx.app, st, randomUUID(), "x");
    expect(a.structuredContent!.code).toBe("not_found");
    expect(JSON.stringify(a.structuredContent)).toBe(JSON.stringify(outline.structuredContent));
    expect(JSON.stringify(b.structuredContent)).toBe(JSON.stringify(outline.structuredContent));
    const vt = (await seedTokenForUser(ctx.db, viewer.id, RW)).token;
    expect((await rename(ctx.app, vt, n.id, "x")).structuredContent).toEqual({ code: "forbidden", message: FORBIDDEN });

    const g = await seedGroup(ctx.db, "Team", [{ userId: creator.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, creator.id, await seedRole(ctx.db, g.id, "Creator", { canRead: true, canCreate: true }));
    const ct = (await seedTokenForUser(ctx.db, creator.id, RW)).token;
    const created = await call(ctx.app, { token: ct }, "create_note", { title: "Mine in group", group_id: g.id });
    const note = created.structuredContent!.note as { id: string; role: string };
    expect(note.role).toBe("viewer");
    expect((await rename(ctx.app, ct, note.id, "x")).structuredContent).toEqual({ code: "forbidden", message: FORBIDDEN });
    expect((await row(ctx.db, n.id)).title).toBe("Private");
  });

  it("matrix over HTTP: rename without if_match (#381), rename + markdown, replace_all + title -> invalid_body; rename without title -> Check: title. + the tail; empty string and NUL -> SDK validation shape; DB unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Stay" });
    const before = await row(ctx.db, n.id);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    // #381: an old-shape rename call (title only) is rejected - tool-level invalid_body, English, naming if_match.
    const e1 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title: "x" });
    expect(e1.structuredContent).toEqual({
      code: "invalid_body",
      message: `This \`rename\` call does not match what that operation needs. Check: if_match. ${INVALID_TAIL}`,
    });
    const e1b = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title: "x", if_match: fingerprintOf("Stay"), markdown: "m" });
    expect(e1b.structuredContent!.code).toBe("invalid_body");
    const e2 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "replace_all", markdown: "m", if_match: DUMMY_FP, title: "x" });
    expect(e2.structuredContent!.code).toBe("invalid_body");
    const e3 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", if_match: fingerprintOf("Stay") });
    expect(e3.structuredContent!.code).toBe("invalid_body");
    expect(e3.structuredContent!.message).toContain("Check: title.");
    expect(e3.structuredContent!.message).toContain(INVALID_TAIL);
    expect((await row(ctx.db, n.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    for (const title of ["", `a${String.fromCharCode(0)}b`]) {
      const e = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title, if_match: fingerprintOf("Stay") });
      expect(e.isError).toBe(true);
      expect(e.structuredContent).toBeUndefined();
    }
    expect((await row(ctx.db, n.id)).title).toBe("Stay");
  });

  it("throttling: tokenWrite limit 1 -> the second call is too_many_requests; with the edit limiter used up rename still succeeds; a session can rename 11 times in a row", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const edit = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite, edit } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "T0" });
    expect(edit.consume(me.id)).toBe(true); // edit limiter used up
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    expect((await rename(ctx.app, token, n.id, "T1")).isError).toBeUndefined();
    expect((await rename(ctx.app, token, n.id, "T2")).structuredContent).toEqual({ code: "too_many_requests", message: TOKEN_RATE_LIMITED });
    const cookie = await sessionCookie(me.id);
    // Back-to-back calls chain on the previous call's titleFingerprint (no read-back).
    let fp = fingerprintOf("T1");
    for (let i = 0; i < 11; i += 1) {
      const r = await call(ctx.app, { cookie }, "edit_note", { note_id: n.id, op: "rename", title: `S${i}`, if_match: fp });
      expect(r.isError, `第 ${i + 1} 發`).toBeUndefined();
      fp = r.structuredContent!.titleFingerprint as string;
    }
  });

  it("interleave: inside slugUpdateTestHook the note is moved into a group -> conflict + RENAME_CONFLICT, title not written; the note is deleted inside the hook -> not_found", async () => {
    const mode: { act?: (db: Parameters<typeof seedUser>[0]) => Promise<void> } = {};
    const holder: { db?: Parameters<typeof seedUser>[0] } = {};
    const ctx = await buildCollabTestApp({ slugUpdateTestHook: async () => { if (mode.act) { const f = mode.act; mode.act = undefined; await f(holder.db!); } } });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Before" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    mode.act = async db => { await db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, n.id)); };
    expect((await rename(ctx.app, token, n.id, "After")).structuredContent).toEqual({ code: "conflict", message: RENAME_CONFLICT });
    expect((await row(ctx.db, n.id)).title).toBe("Before");

    const n2 = await seedNote(ctx.db, { ownerId: me.id }, { title: "Doomed" });
    mode.act = async db => { await db.delete(notes).where(eq(notes.id, n2.id)); };
    expect((await rename(ctx.app, token, n2.id, "After")).structuredContent!.code).toBe("not_found");
    expect(await ctx.db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("a long title (over 200 after JSON escaping) -> the response title is cut + titleTruncated:true, the DB keeps the full text", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Short" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const long = '"'.repeat(150);
    const r = await rename(ctx.app, token, n.id, long);
    expect(r.structuredContent!.titleTruncated).toBe(true);
    expect((r.structuredContent!.title as string).length).toBeLessThan(long.length);
    expect((await row(ctx.db, n.id)).title).toBe(long);
    // #381: the fingerprint is of the **full** title, not the truncated display string; it is the same one the outline gives (the outline's title is cut too).
    expect(r.structuredContent!.titleFingerprint).toBe(fingerprintOf(long));
    const o = await call(ctx.app, { token }, "read_note_outline", { note_id: n.id });
    expect((o.structuredContent!.note as { titleTruncated?: true }).titleTruncated).toBe(true);
    expect(o.structuredContent!.titleFingerprint).toBe(fingerprintOf(long));
    expect((await rename(ctx.app, token, n.id, "Short again", fingerprintOf(long))).isError).toBeUndefined();
  });

  it("web PATCH is still last-write-wins; MCP succeeds if it re-reads the current value first (MCP rename A then REST PATCH B -> B; PATCH C then MCP re-read and rename A -> A)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Start" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const patch = async (title: string) =>
      expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title } })).statusCode).toBe(200);
    await rename(ctx.app, token, n.id, "A");
    await patch("B");
    expect((await row(ctx.db, n.id)).title).toBe("B");
    await patch("C");
    await rename(ctx.app, token, n.id, "A");
    expect((await row(ctx.db, n.id)).title).toBe("A");
  });

  it("session MCP rename succeeds and doesn't charge tokenWrite", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "S" });
    const r = await call(ctx.app, { cookie: await sessionCookie(me.id) }, "edit_note", { note_id: n.id, op: "rename", title: "Session", if_match: fingerprintOf("S") });
    expect(r.structuredContent).toEqual({ title: "Session", titleFingerprint: fingerprintOf("Session"), url: `/n/${me.handle}/session` });
    expect(tokenWrite.consume(`token:${me.id}`)).toBe(true);
  });

  it("the five older ops still carry four response fields (one replace_all, one append)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Content" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const ap = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "append", markdown: "first para" });
    expect(Object.keys(ap.structuredContent!).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"]);
    const ra = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "replace_all", markdown: "replaced", if_match: ap.structuredContent!.fingerprint });
    expect(Object.keys(ra.structuredContent!).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"]);
  });

  it("edge titles: the same title -> url unchanged; colliding with another note in the same scope -> -2; punctuation only -> untitled shape", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    await seedNote(ctx.db, { ownerId: me.id }, { title: "Taken", slug: "taken" });
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Same", slug: "same" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    expect((await rename(ctx.app, token, n.id, "Same")).structuredContent!.url).toBe(`/n/${me.handle}/same`);
    expect((await rename(ctx.app, token, n.id, "Taken")).structuredContent!.url).toBe(`/n/${me.handle}/taken-2`);
    const p = await rename(ctx.app, token, n.id, "!!!");
    expect(p.isError).toBeUndefined();
    expect(p.structuredContent!.url).toMatch(new RegExp(`^/n/${me.handle}/untitled(-\\d+)?$`));
  });

  it("#381 read -> someone edits the title on the web -> rename with the old if_match -> fingerprint_mismatch (exactly code + message), the title is the other person's, slug/updated_at unchanged; after re-reading, renaming succeeds", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "A", slug: "a" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const stale = await titleFpVia(ctx.app, { token }, n.id);
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title: "B" } })).statusCode).toBe(200);
    const afterB = await row(ctx.db, n.id);
    expect(afterB.title).toBe("B");

    const r = await rename(ctx.app, token, n.id, "C", stale);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    const still = await row(ctx.db, n.id);
    expect(still.title).toBe("B");
    expect(still.slug).toBe(afterB.slug);
    expect(still.updatedAt.getTime()).toBe(afterB.updatedAt.getTime());

    const fresh = await titleFpVia(ctx.app, { token }, n.id);
    expect(fresh).toBe(fingerprintOf("B"));
    expect((await rename(ctx.app, token, n.id, "C", fresh)).structuredContent!.title).toBe("C");
    expect((await row(ctx.db, n.id)).title).toBe("C");
  });

  it("#381 concurrency: after the comparison passes and before the UPDATE (slugUpdateTestHook) someone changes the title -> fingerprint_mismatch, the title is theirs; after re-reading, renaming succeeds", async () => {
    const mode: { act?: (db: Parameters<typeof seedUser>[0]) => Promise<void> } = {};
    const holder: { db?: Parameters<typeof seedUser>[0] } = {};
    const ctx = await buildCollabTestApp({ slugUpdateTestHook: async () => { if (mode.act) { const f = mode.act; mode.act = undefined; await f(holder.db!); } } });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Before", slug: "before" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const fp = await titleFpVia(ctx.app, { token }, n.id);
    // Writes someone else's title (= the sentence a web PATCH had committed) after rename's pre-read (including the fingerprint comparison) and before the conditional UPDATE.
    mode.act = async db => { await db.update(notes).set({ title: "Theirs" }).where(eq(notes.id, n.id)); };
    const r = await rename(ctx.app, token, n.id, "Mine", fp);
    expect(mode.act).toBeUndefined(); // the hook really fired in this call
    expect(r.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect((await row(ctx.db, n.id)).title).toBe("Theirs");

    const fresh = await titleFpVia(ctx.app, { token }, n.id);
    expect(fresh).toBe(fingerprintOf("Theirs"));
    expect((await rename(ctx.app, token, n.id, "Mine", fresh)).isError).toBeUndefined();
    expect((await row(ctx.db, n.id)).title).toBe("Mine");
  });

  it("#381 the body if_match doesn't cover the title: after getting a section/whole-note fingerprint someone changes the title -> replace_section and replace_all still succeed; conversely after getting titleFingerprint the body changes -> rename still succeeds; a body fingerprint used as rename's if_match -> fingerprint_mismatch", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Body" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const patch = async (title: string) =>
      expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title } })).statusCode).toBe(200);
    const edit = (args: Record<string, unknown>) => call(ctx.app, { token }, "edit_note", { note_id: n.id, ...args });

    const ap = await edit({ op: "append", markdown: "# Head\n\nfirst" });
    expect(ap.isError).toBeUndefined();
    const head = (ap.structuredContent!.outline as { sections: Array<{ sectionId: string; heading: string; fingerprint: string }> }).sections.find(s => s.heading === "Head")!;

    await patch("Renamed in browser 1");
    const rs = await edit({ op: "replace_section", section_id: head.sectionId, markdown: "# Head\n\nsecond", if_match: head.fingerprint });
    expect(rs.isError, JSON.stringify(rs.structuredContent)).toBeUndefined();

    await patch("Renamed in browser 2");
    const ra = await edit({ op: "replace_all", markdown: "# Head\n\nthird", if_match: rs.structuredContent!.fingerprint });
    expect(ra.isError, JSON.stringify(ra.structuredContent)).toBeUndefined();

    const tfp = await titleFpVia(ctx.app, { token }, n.id);
    expect((await edit({ op: "append", markdown: "more" })).isError).toBeUndefined();
    const wrongKind = await rename(ctx.app, token, n.id, "Nope", ra.structuredContent!.fingerprint as string);
    expect(wrongKind.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect((await row(ctx.db, n.id)).title).toBe("Renamed in browser 2");
    expect((await rename(ctx.app, token, n.id, "Final", tfp)).isError).toBeUndefined();
    expect((await row(ctx.db, n.id)).title).toBe("Final");
  });
});
