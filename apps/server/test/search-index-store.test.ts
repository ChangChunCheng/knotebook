// The WS form goes through buildCollabTestApp; deterministic timing (logger / extraction failures) calls createNoteStore directly.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createNoteStore } from "../src/collab/store.js";
import { noteAiEdits, noteStateBackups, noteStates, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bumpSearchIndexVersion, writeSearchIndex } from "../src/notes/search-index.js";
import { SEARCH_INDEX_NOTE_MAX, SEARCH_INDEX_SECTIONS_MAX } from "../src/notes/search-text.js";
import { buildCollabTestApp, freshDb } from "./helpers.js";
import { bearer, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { captureLog, indexRows, noteStateVersion, stateRow, waitIndexed } from "./search-helpers.js";

const PASSWORD = "correct-horse-battery";

function writeParagraph(doc: Y.Doc, id: string, text: string): Y.XmlText {
  const f = doc.getXmlFragment(YDOC_FRAGMENT);
  let group = f.get(0) as Y.XmlElement | undefined;
  if (!(group instanceof Y.XmlElement)) {
    group = new Y.XmlElement("blockGroup");
    f.insert(0, [group]);
  }
  const c = new Y.XmlElement("blockContainer");
  group.insert(group.length, [c]);
  c.setAttribute("id", id);
  const p = new Y.XmlElement("paragraph");
  c.insert(0, [p]);
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, text);
  return t;
}

describe("normal persist (WS)", () => {
  it("WS edit -> index matches content after persist; deleting a run of text (docClock unchanged) -> the old text is not searchable after persist", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "s1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("s1@example.com", PASSWORD);
    const client = await session.connect(note.id);
    const t = writeParagraph(client.doc, "p1", "keep SECRETWORD tail");
    await waitIndexed(ctx.db, note.id, b => b.includes("SECRETWORD"));
    expect((await indexRows(ctx.db, note.id)).map(r => [r.sectionId, r.body])).toEqual([["_top", "keep SECRETWORD tail"]]);
    t.delete(5, 11); // deletes 'SECRETWORD ' - a Yjs delete does not advance the state vector
    await waitIndexed(ctx.db, note.id, b => !b.includes("SECRETWORD"));
    expect((await indexRows(ctx.db, note.id)).map(r => r.body)).toEqual(["keep tail"]);
    client.disconnect();
  });
});

describe("AI path (mergeDiff disconnect is the persist point; the index is done before the response)", () => {
  async function setupAi() {
    const ctx = await buildCollabTestApp({ limiters: { edit: new FixedWindowLimiter({ limit: 1000, windowMs: 60_000 }) } });
    const u = await ctx.createUser({ email: "s2@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("s2@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# A\n\nalpha line\n\n# B\n\nbravo line");
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    await waitIndexed(ctx.db, note.id, b => b.includes("bravo line"));
    return { ctx, note, client, token };
  }

  it("right after the replace_section response: the new paragraph id is searchable, the old id's row is gone", async () => {
    const { ctx, note, client, token } = await setupAi();
    const before = (await getContent(ctx.app, note.id, token)).json();
    const oldB = before.outline[2];
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_section", section_id: oldB.sectionId, markdown: "# B2\n\ncharlie line", if_match: oldB.fingerprint } });
    expect(res.statusCode).toBe(201);
    const rows = await indexRows(ctx.db, note.id); // no waiting: the index is already written before the response
    expect(rows.map(r => r.body).join("\n")).toContain("charlie line");
    expect(rows.map(r => r.sectionId)).not.toContain(oldB.sectionId);
    const after = (await getContent(ctx.app, note.id, token)).json();
    expect(rows.map(r => r.sectionId)).toEqual(after.outline.filter((o: { chars: number }) => o.chars > 0).map((o: { sectionId: string }) => o.sectionId));
    client.disconnect();
  });

  it("right after the revert response: content is back to the previous version", async () => {
    const { ctx, note, client, token } = await setupAi();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "delta line" } });
    expect(res.statusCode).toBe(201);
    expect((await indexRows(ctx.db, note.id)).map(r => r.body).join("\n")).toContain("delta line");
    const [edit] = await ctx.db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
    const rv = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits/${edit!.id}/revert`, headers: bearer(token) });
    expect(rv.statusCode).toBe(201);
    expect((await indexRows(ctx.db, note.id)).map(r => r.body).join("\n")).not.toContain("delta line");
    client.disconnect();
  });

  it("POST /api/notes with content -> searchable right after the 201", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "s2c@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const res = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "Created", content: "# Intro\n\necho line" } });
    expect(res.statusCode).toBe(201);
    expect((await indexRows(ctx.db, res.json().id)).map(r => r.body).join("\n")).toContain("echo line");
  });
});

describe("failure isolation", () => {
  it("indexer throws (via the collab wrapper) -> persist, backup and last_edited still written, one warn", async () => {
    const ctx = await buildCollabTestApp({ storeSearchHooks: { indexer: async () => { throw new Error("indexer boom"); } } });
    const owner = await ctx.createUser({ email: "s6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("s6@example.com", PASSWORD);
    const client = await session.connect(note.id);
    writeParagraph(client.doc, "p1", "still persisted");
    // Wait for the collab wrapper's last step (last_edited is written only after noteStore.onStoreDocument resolves);
    // waiting only for the warn would release before the last_edited UPDATE.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await ctx.db.select({ at: notes.lastEditedAt }).from(notes).where(eq(notes.id, note.id));
      if (row?.at) break;
      if (Date.now() > deadline) throw new Error("等待 last_edited 逾時");
      await new Promise(r => setTimeout(r, 50));
    }
    expect(await noteStateVersion(ctx.db, note.id)).toBe(1);
    expect(await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).toHaveLength(1);
    const [n] = await ctx.db.select({ at: notes.lastEditedAt, by: notes.lastEditedBy }).from(notes).where(eq(notes.id, note.id));
    expect(n).toMatchObject({ by: owner.id });
    expect(n!.at).not.toBeNull();
    expect(ctx.collabLogs.filter(l => l.msg.startsWith("全文索引更新失敗"))).toHaveLength(1);
    client.disconnect();
  });

  it("indexer and logger both throw -> onStoreDocument still resolves", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({ db, log: { warn: () => { throw new Error("logger boom"); } }, indexer: async () => { throw new Error("indexer boom"); } });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await expect(store.onStoreDocument(n.id, doc)).resolves.toBeUndefined();
    expect(await noteStateVersion(db, n.id)).toBe(1);
  });

  it("extraction throws -> persist as usual, no index transaction opened, one warn", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const { log, warns } = captureLog();
    let calls = 0;
    const store = createNoteStore({ db, log, extract: () => { throw new Error("extract boom"); }, indexer: async () => { calls += 1; return "written"; } });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await store.onStoreDocument(n.id, doc);
    expect(await noteStateVersion(db, n.id)).toBe(1);
    expect(calls).toBe(0);
    expect(warns.filter(w => w.msg.startsWith("全文索引抽取失敗"))).toHaveLength(1);
  });

  it("extraction and logger both throw -> onStoreDocument still resolves, persist as usual", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({ db, log: { warn: () => { throw new Error("logger boom"); } }, extract: () => { throw new Error("extract boom"); } });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await expect(store.onStoreDocument(n.id, doc)).resolves.toBeUndefined();
    expect(await noteStateVersion(db, n.id)).toBe(1);
  });
});

describe("hostile and huge documents", () => {
  it("WS sends 5000 levels deep + NUL + lone surrogate + 2001 paragraphs -> persist succeeds, document unloads (not pinned), index has 2000 rows + capped", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "s7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("s7@example.com", PASSWORD);
    const client = await session.connect(note.id);
    client.doc.transact(() => {
      writeParagraph(client.doc, "p0", "nul\u0000and\uD800lone");
      const group = client.doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
      let parent = group.get(0) as Y.XmlElement;
      for (let i = 0; i < 5000; i += 1) {
        const child = new Y.XmlElement("blockContainer");
        parent.insert(parent.length, [child]);
        parent = child;
      }
      for (let i = 0; i < SEARCH_INDEX_SECTIONS_MAX + 1; i += 1) {
        const c = new Y.XmlElement("blockContainer");
        group.insert(group.length, [c]);
        c.setAttribute("id", `h${i}`);
        const h = new Y.XmlElement("heading");
        c.insert(0, [h]);
        h.setAttribute("level", "1");
        const t = new Y.XmlText();
        h.insert(0, [t]);
        t.insert(0, `head ${i}`);
      }
    });
    await waitIndexed(ctx.db, note.id, b => b.includes("head 1998"), 30_000);
    client.disconnect();
    await waitFor("文件卸載", 15_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const rows = await indexRows(ctx.db, note.id);
    expect(rows).toHaveLength(SEARCH_INDEX_SECTIONS_MAX);
    expect(rows[0]!.sectionId).toBe("_top");
    expect(rows[0]!.body).toContain("nul\uFFFDand\uFFFDlone");
    expect(rows.map(r => r.body).join("\n")).not.toContain("head 1999");
    expect((await stateRow(ctx.db, note.id))!.capped).toBe(true);
  });

  it("a note with a 260 000-char heading (mcp-size) -> heading stored as 1000, body within the limit and keeps its tail", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "s8@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("s8@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, `# ${"H".repeat(260_000)}\n\n${"B".repeat(20_000)} tail`);
    await waitIndexed(ctx.db, note.id, b => b.endsWith(" tail"), 30_000);
    const rows = await indexRows(ctx.db, note.id);
    const h = rows.find(r => r.heading.startsWith("H"))!;
    expect(h.heading).toBe("H".repeat(1000));
    expect(h.body.startsWith("H".repeat(260_000))).toBe(true);
    expect(rows.reduce((s, r) => s + r.body.length, 0)).toBeLessThanOrEqual(SEARCH_INDEX_NOTE_MAX);
    client.disconnect();
  });
});

describe("calling createNoteStore directly, deterministic", () => {
  async function storeWithCounters() {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const calls = { index: 0, bump: 0 };
    const { log, warns } = captureLog();
    const store = createNoteStore({
      db,
      log,
      indexer: (id, v, e) => { calls.index += 1; return writeSearchIndex(db, id, v, e); },
      bumper: (id, v, h) => { calls.bump += 1; return bumpSearchIndexVersion(db, id, v, h); },
    });
    return { db, n, calls, store, warns };
  }

  it("same content persisted twice -> the second opens no index transaction, source_version advances; the cache is cleared after afterUnloadDocument", async () => {
    const { db, n, calls, store } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "cached text");
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 1 });
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
    store.afterUnloadDocument(n.id);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 1 });
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(3);
  });

  it("self-healing: bump hits 0 rows -> the same persist switches to the full transaction (indexed this time), then back to bump", async () => {
    const { db, n, calls, store } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "heal");
    await store.onStoreDocument(n.id, doc);
    const goodHash = (await stateRow(db, n.id))!.contentHash;
    // The index was changed by someone else: hash and section contents no longer describe this note.
    await db.execute(sql`update note_search_state set content_hash = 'other' where note_id = ${n.id}::uuid`);
    await db.execute(sql`update note_search_sections set body = 'stale' where note_id = ${n.id}::uuid`);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 1 });
    const st = (await stateRow(db, n.id))!;
    expect(st.contentHash).toBe(goodHash);
    expect(st.sourceVersion).toBe(await noteStateVersion(db, n.id));
    expect((await indexRows(db, n.id)).map(r => r.body).join("\n")).toContain("heal");
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 2 });
  });

  it("new text inserted into the doc after persist but before indexing -> indexed content = the persisted snapshot, source_version = the persisted version", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({ db, afterPersistForTest: async (_id, d) => { writeParagraph(d, "late", "LATEWORD"); } });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "persisted snapshot");
    await store.onStoreDocument(n.id, doc);
    expect((await indexRows(db, n.id)).map(r => r.body).join("\n")).not.toContain("LATEWORD");
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(await noteStateVersion(db, n.id));
    const [persisted] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, n.id));
    const back = new Y.Doc();
    Y.applyUpdate(back, persisted!.ydoc);
    expect(back.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("LATEWORD");
  });

  it("note already deleted at persist time -> indexer not called, no warn, cache cleared too", async () => {
    const { db, n, calls, store, warns } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await store.onStoreDocument(n.id, doc);
    expect(calls.index).toBe(1);
    const [noteRow] = await db.select().from(notes).where(eq(notes.id, n.id));
    await db.delete(notes).where(eq(notes.id, n.id));
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    expect(warns).toEqual([]);
    // The only way to observe the cache: put the same row back (cascade took note_states and the index) and persist the same
    // content again - a cleared cache goes the full transaction (index: 2); a leftover hash would go bump (bump: 1, hits 0 rows).
    await db.insert(notes).values(noteRow!);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 0 });
  });
});
