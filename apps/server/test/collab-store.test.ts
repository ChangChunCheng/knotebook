import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteStateBackups, noteStates } from "../src/db/schema.js";
import { createNoteStore } from "../src/collab/store.js";
import { purgeTrashedNotesInTx } from "../src/notes/tx/trash.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

/** Async check, for polling the DB. */
async function waitForAsync(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("onLoadDocument/onStoreDocument + optimistic lock + bucketed backups", () => {
  it("after an edit note_states has data within 5 s, content matching the edit", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store1@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "hello store");

    await waitForAsync("note_states 有資料", 5_000, async () => {
      const [row] = await ctx.db.select({ noteId: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return row !== undefined;
    });

    const [row] = await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
    expect(row?.version).toBe(1);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, row!.ydoc);
    expect(restored.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>hello store</paragraph>");
  });

  it("reconnect: content is restored from note_states (reconnecting only after the document really unloaded from memory)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store2@example.com", PASSWORD);

    const a = await session.connect(note.id);
    insertParagraph(a.doc, "persisted content");

    await waitForAsync("note_states 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ noteId: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r !== undefined;
    });

    a.disconnect();

    // Confirm the document really unloaded from Hocuspocus memory - otherwise the reconnect might get the same Document instance still in memory
    // and not test "restored from DB".
    await waitFor("文件從記憶體卸載", 5_000, () => !ctx.collab.hocuspocus.documents.has(note.id));

    const b = await session.connect(note.id);
    expect(b.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>persisted content</paragraph>");
  });

  it("two edits inside the same 15-minute bucket -> exactly 1 backup (the second store doesn't back up again)", async () => {
    // The clock is fixed in the middle of the [10:00,10:15) bucket: both stores deterministically land in the same bucket, unaffected by the real wall clock crossing a bucket.
    const ctx = await buildCollabTestApp({ storeSearchHooks: { now: () => new Date("2026-01-05T10:07:30Z") } });
    const owner = await ctx.createUser({ email: "owner-store3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store3@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "v1");
    await waitForAsync("第一次 store 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r?.version === 1;
    });

    insertParagraph(client.doc, "v2");
    await waitForAsync("第二次 store 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r?.version === 2;
    });

    // The injected fixed clock puts both stores in the same 15-minute bucket - the first necessarily writes one because lastBackupAt=null;
    // the second doesn't cross a bucket and must be skipped.
    const backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1);
  });

  it("crossing a bucket but content unchanged (equal state vector) -> no new backup (calls store.ts directly: the real 15-minute bucket boundary can't be waited for in a test, a controllable clock is needed)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    // This subtest deliberately avoids real-time collab WebSocket round trips - backup-policy's bucket boundaries align with the real UTC clock at 15-minute width,
    // which a test can't wait for, and the "content unchanged" premise requires no new edit at all between the two stores (an edit necessarily changes sv,
    // so this rule wouldn't be exercised). A standalone `createNoteStore` instance (same ctx.db) with a controllable `now` is the workable approach.
    let clock = new Date("2026-01-05T10:07:00Z");
    const store = createNoteStore({ db: ctx.db, now: () => clock });

    const doc = new Y.Doc();
    await store.onLoadDocument(note.id, doc); // no existing row: the sv cache is initialized with an empty doc

    insertParagraph(doc, "only edit");
    await store.onStoreDocument(note.id, doc); // first store: lastBackupAt=null -> true and sv differs from the empty doc -> should write 1 backup

    let backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1);

    // Cross into the next 15-minute bucket (10:07 in [10:00,10:15) -> 10:20 in [10:15,10:30)); the doc isn't edited again,
    // so sv should equal the cache.
    clock = new Date("2026-01-05T10:20:00Z");
    await store.onStoreDocument(note.id, doc);

    backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1); // no new one added

    // Corroboration: note_states is still overwritten as usual (the sole-writer rule isn't affected by "skipping the backup").
    const [row] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
    expect(row?.version).toBe(2);
  });

  it("a pending store during permanent deletion doesn't resurrect the row (using the default noop hooks: when DELETE moves it into the trash and the permanent deletion lands, the store debounce is still pending)", async () => {
    // Deliberately use the default (noop) collabHooks, not the real implementation - the real beforeNoteDeleted flushes + unloads before the delete transaction,
    // so the store would land before the DELETE and the "row resurrected" race wouldn't be tested; noop lets the DELETE land first while the store debounce
    // is still pending, which is exactly why this rule exists (the deleting gate depends on this rule).
    // #181: DELETE only moves it into the trash (the row stays, a stray store still writes) - "discard if the note doesn't exist" is only reachable via permanent deletion,
    // so within the same debounce window after the move the permanent-deletion transaction body is called directly.
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store5@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "doomed by delete");

    // Delete immediately, before the 2000 ms store debounce fires.
    const delRes = await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);
    const purged = await ctx.db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [note.id], by: owner.id }));
    expect(purged.done).toEqual([note.id]);

    // Wait past the debounce plus a safety margin so the pending store really runs once.
    await sleep(3_000);

    const rows = await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id));
    expect(rows).toEqual([]);

    const backupRows = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backupRows).toEqual([]);
  });
});

/**
 * issue #44 minimal step, behaviour side: when onStoreDocument finds a "url attribute with a non-http(s) scheme" it logs one warn - at most one line **per note per load cycle**
 * (onStoreDocument arrives every 2 s of debounce, so without a gate a polluted note would flood the log at a fixed rate, the same shape as #50); reloading after unload
 * warns once more (visible after a process restart too, so the signal doesn't vanish permanently). It only logs, never rewrites or rejects.
 */
describe("onStoreDocument dangerous URL scan (issue #44)", () => {
  it("polluted document: the first store logs one warn, a store in the same cycle doesn't repeat; a store after unload warns again; a clean document gets zero warns", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "scan-owner@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const cleanNote = await ctx.createNote(owner.id);

    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const store = createNoteStore({ db: ctx.db, log: { warn: (obj, msg) => warns.push({ obj: { ...obj }, msg }) } });

    const doc = new Y.Doc();
    await store.onLoadDocument(note.id, doc);
    const poisoned = new Y.XmlElement("image");
    poisoned.setAttribute("url", "javascript:alert(1)");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [poisoned]);

    await store.onStoreDocument(note.id, doc);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ noteId: note.id, findings: 1, schemes: ["javascript:"], blocks: ["image"] });
    // The attacker-controlled URL itself must not enter the log.
    expect(JSON.stringify(warns[0])).not.toContain("alert");

    insertParagraph(doc, "more edits");
    await store.onStoreDocument(note.id, doc);
    expect(warns).toHaveLength(1);

    // unload -> reload -> store: the signal reappears (the same warn sink also receives the optimistic-lock conflict line,
    // so the fields of the second line must really be verified, not just count lines).
    store.afterUnloadDocument(note.id);
    const doc2 = new Y.Doc();
    await store.onLoadDocument(note.id, doc2);
    await store.onStoreDocument(note.id, doc2);
    expect(warns).toHaveLength(2);
    expect(warns[1]!.obj).toMatchObject({ noteId: note.id, findings: 1, schemes: ["javascript:"], blocks: ["image"] });

    const cleanDoc = new Y.Doc();
    await store.onLoadDocument(cleanNote.id, cleanDoc);
    insertParagraph(cleanDoc, "hello");
    await store.onStoreDocument(cleanNote.id, cleanDoc);
    expect(warns).toHaveLength(2);
  });

  it("the distinct list in the log line is capped: 11 distinct block names -> blocks lists only 10, blocksTotal=11 (the behaviour the docs claim)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "scan-cap-owner@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const store = createNoteStore({ db: ctx.db, log: { warn: (obj, msg) => warns.push({ obj: { ...obj }, msg }) } });

    const doc = new Y.Doc();
    await store.onLoadDocument(note.id, doc);
    for (let i = 0; i < 11; i += 1) {
      const el = new Y.XmlElement(`custom-block-${i}`);
      el.setAttribute("url", "javascript:x");
      doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [el]);
    }

    await store.onStoreDocument(note.id, doc);
    expect(warns).toHaveLength(1);
    const obj = warns[0]!.obj as { findings: number; blocks: string[]; blocksTotal: number; schemes: string[]; schemesTotal: number };
    expect(obj.findings).toBe(11);
    expect(obj.blocks).toHaveLength(10);
    expect(obj.blocksTotal).toBe(11);
    expect(obj.schemes).toEqual(["javascript:"]);
    expect(obj.schemesTotal).toBe(1);
  });
});
