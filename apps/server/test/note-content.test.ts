import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import { noteStateBackups, notes, noteStates } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { buildCollabTestApp, buildTestApp, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { loadDoc, xmlOf } from "./copy-helpers.js";

const PASSWORD = "correct-horse-battery";
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signTestSession({ userId, tv: 0 })}`;

// No behavioural test can pin read.ts's invariant that no `await` sits between `documents.get` and `forkFrom(live)`: a destroyed
// Y.Doc still encodes its pre-destroy content (destroy() doesn't clear the store, and encodeStateAsUpdate neither throws nor
// returns empty), so a test would have to fake a destroy behaviour real Y.Doc lacks and would assert our own invention.
// Yielding a microtask there can return a doc that @hocuspocus/server's unloadDocument has already removed (it calls documents.delete, then document.destroy()).
// The invariant is guarded by a source-text check. Breaking it silently returns a stale snapshot and fingerprint (no 500/4xx),
// and #137's if-match conditional update takes that fingerprint as its baseline.
// The start marker `"documents.get(noteId)"` occurs once in each of loadNoteState and loadNoteDoc (asserted below), and the end markers
// `forkFrom(live)` and `encodeStateAsUpdate(live)` occur only at those sites (the import line has only a bare `forkFrom`, the header
// comment only a bare `documents.get`); symbol names drift less than line numbers. indexOf
// returns -1 on a miss, so the test asserts `documents.get(noteId)` was found twice and drops end-marker misses before taking the nearest end.
// Boundary: this only catches the literal `await` between the markers, not one moved before `documents.get`
// (`const live = await Promise.resolve(...documents.get(noteId));`) nor yielding via `.then()`/`queueMicrotask`.
describe("read.ts source guard: no await between documents.get and forkFrom(live)/encodeStateAsUpdate(live)", () => {
  it("literal text contains no await (loadNoteDoc and loadNoteState)", () => {
    const src = readFileSync(new URL("../src/notes/editing/read.ts", import.meta.url), "utf8");
    const starts: number[] = [];
    for (let i = src.indexOf("documents.get(noteId)"); i !== -1; i = src.indexOf("documents.get(noteId)", i + 1)) starts.push(i);
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      const ends = ["forkFrom(live)", "encodeStateAsUpdate(live)"].map(t => src.indexOf(t, start)).filter(i => i !== -1);
      const end = Math.min(...ends);
      expect(end).toBeGreaterThan(start);
      // The header and inline comments themselves mention `await`, so whole-line `//` comment lines are filtered out first;
      // a real inserted `await` is not a comment line and survives the filter.
      const between = src
        .slice(start, end)
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
      expect(between).not.toContain("await");
    }
  });
});

describe("GET /api/notes/:id/content", () => {
  it("owner/editor/viewer 200; none 404; no credentials 401 with a challenge", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "o@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "e@example.com", password: PASSWORD });
    const viewer = await ctx.createUser({ email: "v@example.com", password: PASSWORD });
    const other = await ctx.createUser({ email: "x@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editor.id, "editor");
    await ctx.share(note.id, viewer.id, "viewer");
    for (const [u, status] of [
      [owner, 200],
      [editor, 200],
      [viewer, 200],
      [other, 404],
    ] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
      expect((await getContent(ctx.app, note.id, token)).statusCode, u.id).toBe(status);
    }
    const anon = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content` });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("owner's cookie also reads 200 without loading an extra document", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}/content`,
      headers: { cookie: await cookieFor(u.id) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastEdited).toBeNull();
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
  });

  it("text just typed by a WS client is readable; ?section= returns only that section (keyed by id); with a heading first, outline[0] is a zero-block _top; unknown section 404 section_not_found", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    // Two headings at the same level: a deeper heading is merged into the previous section (sectionize rule, pinned by
    // note-sections.test.ts "h2->h3->h2"), so `## B` would give only two sections, not the shape under test.
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段\n\n# B\n\n第二段");
    // The provider's edit must reach the server's live doc (WS round trip) before the read path can fork it
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("第二段"));
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await getContent(ctx.app, note.id, token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toContain("第一段");
    expect(body.outline[0]).toMatchObject({ sectionId: "_top", level: 0, heading: "", chars: 0 });
    expect(body.outline.map((o: { heading: string }) => o.heading)).toEqual(["", "A", "B"]);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // The outline is a public DTO (`NoteOutlineEntry`): internal blockIds must not leak
    expect(body.outline.every((o: Record<string, unknown>) => o.blockIds === undefined)).toBe(true);
    // Each row's fingerprint is that section's own, not a copy of the whole-note one (the degradation `fingerprint.ts` forbids:
    // falling back to the whole-note fingerprint on mismatch): three different sections must give different fingerprints and none
    // may equal the whole-note fingerprint (#137's conditional update uses it as the baseline).
    for (const o of body.outline) expect(o.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(body.outline.map((o: { fingerprint: string }) => o.fingerprint)).size).toBe(3);
    expect(body.outline.every((o: { fingerprint: string }) => o.fingerprint !== body.fingerprint)).toBe(true);
    const secId = body.outline[2].sectionId;
    const sec = (await getContent(ctx.app, note.id, token, secId)).json();
    expect(sec.section.id).toBe(secId);
    expect(sec.section.sectionId).toBeUndefined();
    expect(sec.section.markdown).toContain("第二段");
    expect(sec.section.markdown).not.toContain("第一段");
    // The section endpoint's fingerprint must be the same value as the outline row's, not a coincidental recomputation.
    expect(sec.section.fingerprint).toBe(body.outline[2].fingerprint);
    expect(sec.outline).toBeUndefined();
    expect(sec.fingerprint).toBeUndefined();
    // Section-shaped responses carry no whole-note outline/fingerprint, and `lastEdited` is real (#137) so it can't be asserted null
    // (the note was just edited and the human signature appears once persisted): the top-level keys are only `section` and
    // `lastEdited`. The value itself is checked at the end of this case, where persisting is a settled event.
    expect(Object.keys(sec).sort()).toEqual(["lastEdited", "section"]);
    // Zero-block `_top` (document starts with a heading): markdown is the empty string, not the "\n" that mount normalizes to
    const top = (await getContent(ctx.app, note.id, token, "_top")).json();
    expect(top.section).toMatchObject({ id: "_top", markdown: "", chars: 0 });
    const missing = await getContent(ctx.app, note.id, token, "nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("section_not_found");
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    // After persisting, last_edited_* is a human signature (a settled event): section and whole-note forms must both return real
    // values: byHandle is that editor, agentLabel null (no AI wrote). The handle can't be hardcoded as `"a"` (the email local part):
    // `ctx.createUser` passes no handle, so the column takes the DB default (`'user-' || substr(gen_random_uuid()::text, 1, 8)`).
    // Compare against the real value, not `expect.any(String)`: this cell guards that the signature points at that editor.
    const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json().ownerHandle;
    const settledSec = (await getContent(ctx.app, note.id, token, secId)).json();
    expect(settledSec.lastEdited).toMatchObject({ byHandle: ownerHandle, agentLabel: null });
    expect((await getContent(ctx.app, note.id, token)).json().lastEdited).toMatchObject({ byHandle: ownerHandle, agentLabel: null });
  });

  it("with nobody online the DB snapshot is read; a never-opened note returns an empty document shape; two reads give the same fingerprint", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const empty = (await getContent(ctx.app, note.id, token)).json();
    expect(empty).toMatchObject({ markdown: "", outline: [{ sectionId: "_top", chars: 0 }], lastEdited: null });
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(empty.fingerprint);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "hello");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("hello"));
    client.disconnect();
    // After disconnect the store (debounce 2000 ms) runs first, then unload (hocuspocus storeDocumentHooks -> unloadDocument;
    // `destroy()` in collab/server.ts likewise waits for documents to drain)
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    expect((await getContent(ctx.app, note.id, token)).json().markdown).toContain("hello");
  });

  it("read false-green guard: after 20 consecutive reads note_states is unchanged, no new backup row, documents.size unchanged, the four notes.last_edited_* columns unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "x");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("x"));
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const before = (await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]!;
    const backups = (await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).length;
    const lastEditedBefore = (await ctx.db.select().from(notes).where(eq(notes.id, note.id)))[0]!;
    const { token } = await seedTokenForUser(ctx.db, u.id);
    for (let i = 0; i < 20; i += 1) expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(200);
    const after = (await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]!;
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).length).toBe(backups);
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
    const lastEditedAfter = (await ctx.db.select().from(notes).where(eq(notes.id, note.id)))[0]!;
    expect({
      lastEditedAt: lastEditedAfter.lastEditedAt?.getTime() ?? null,
      lastEditedBy: lastEditedAfter.lastEditedBy,
      lastEditedTokenId: lastEditedAfter.lastEditedTokenId,
      lastEditedAgentLabel: lastEditedAfter.lastEditedAgentLabel,
    }).toEqual({
      lastEditedAt: lastEditedBefore.lastEditedAt?.getTime() ?? null,
      lastEditedBy: lastEditedBefore.lastEditedBy,
      lastEditedTokenId: lastEditedBefore.lastEditedTokenId,
      lastEditedAgentLabel: lastEditedBefore.lastEditedAgentLabel,
    });
  });

  // Core of the read path's zero side effects: the live doc is only forked, never handed out. HTTP responses can't show this: for a
  // well-formed non-empty document mount currently changes nothing, so handing out `live` itself would still pass them. So identity
  // and isolation are asserted directly on `loadNoteDoc`.
  it("loadNoteDoc: with someone online returns a fork (not the live doc; editing it leaves live untouched); with nobody online returns the DB snapshot with loaded=false", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "hello");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("hello"));
    const live = ctx.collab.hocuspocus.documents.get(note.id)!;
    const liveText = docText(live);
    const forked = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    expect(forked.loaded).toBe(true);
    expect(forked.doc).not.toBe(live);
    expect(docText(forked.doc)).toBe(liveText);
    forked.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [new Y.XmlElement("blockGroup")]);
    expect(docText(forked.doc)).not.toBe(liveText); // precondition: the edit above really changed the fork
    expect(docText(live)).toBe(liveText);
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const fromDb = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    expect(fromDb.loaded).toBe(false);
    expect(docText(fromDb.doc)).toBe(liveText);
  });

  it("CONTENT_READ_LIMIT: with limit 3 the 4th read gets 429; a none 404 doesn't consume it (a stranger's 5x404, then reading own note still gives 3x200 before 429)", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "s@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const own = await ctx.createNote(stranger.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const { token: st } = await seedTokenForUser(ctx.db, stranger.id);
    for (let i = 0; i < 5; i += 1) expect((await getContent(ctx.app, note.id, st)).statusCode).toBe(404);
    for (let i = 0; i < 3; i += 1) expect((await getContent(ctx.app, own.id, st)).statusCode).toBe(200);
    expect((await getContent(ctx.app, own.id, st)).statusCode).toBe(429);
    for (let i = 0; i < 3; i += 1) expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(200);
    expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(429);
  });

  it("section with NUL or bad format -> 400 invalid_body (unstorable strings are rejected before SQL); an app without collab doesn't register this route", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const NUL = String.fromCharCode(0);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}/content?section=${encodeURIComponent("a" + NUL)}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // A char SECTION_ID_RE rejects (`.`) is also 400: separates "NUL blocked" from "the format gate exists".
    const bad = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content?section=a.b`, headers: bearer(token) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_body");
    // A non-uuid :id -> 404 (not sent into resolveRole's SQL to blow up as a 500)
    const notUuid = await ctx.app.inject({ method: "GET", url: "/api/notes/not-a-uuid/content", headers: bearer(token) });
    expect(notUuid.statusCode).toBe(404);
    expect(notUuid.json().error.code).toBe("not_found");
    // Without collab the route doesn't exist: if it were registered the preHandler would answer 401 (no credentials) first,
    // so 404-not-401 proves it isn't registered.
    const plain = await buildTestApp();
    const r2 = await plain.app.inject({ method: "GET", url: `/api/notes/${note.id}/content` });
    expect(r2.statusCode).toBe(404);
  });

  it("#240 Bearer GET /content with an uppercase id: reads live content inside the debounce window", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "r1@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id); // all setup runs before seed: the debounce window starts as soon as seed returns
    const session = await ctx.loginAs("r1@example.com", PASSWORD);
    const MARK = `MARK-${randomUUID()}`;
    const client = await seedContent(ctx, session, note.id, `# Head\n\n${MARK}`);
    const seededAt = Date.now();
    const res = await getContent(ctx.app, note.id.toUpperCase(), token);
    // Ordered first: with the hook removed the read hits note_states, which has no MARK yet.
    expect(res.json().markdown).toContain(MARK);
    const stateHasMark = async () => { const d = await loadDoc(ctx.db, note.id); return d !== null && xmlOf(d).includes(MARK); };
    expect(await stateHasMark()).toBe(false); // the read happens inside the debounce window; if this turns true the case loses its discriminating power
    console.log(`[content] seed→斷言 ${Date.now() - seededAt} ms（store debounce 2000 ms）`);
    expect(res.statusCode).toBe(200);
    client.disconnect();
  });
});
