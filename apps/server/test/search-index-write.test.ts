// The code under test is always the real `writeSearchIndex`; the holder only plays "the other side" (DELETE, note_states rewrite).
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { freshDb } from "./helpers.js";
import { seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { noteSearchState } from "../src/db/schema.js";
import { bumpSearchIndexVersion, writeSearchIndex } from "../src/notes/search-index.js";
import { purgeTrashedNotesInTx } from "../src/notes/tx/trash.js";
import { markTrashed } from "./trash-helpers.js";
import { searchDoc } from "./search-doc.js";
import { captureLog, extractOf, indexRows, makeGate, seedNoteState, setNoteState, stateRow } from "./search-helpers.js";

const V1 = [{ id: "p", text: "version one alpha" }];
const V2 = [{ id: "p", text: "version two bravo" }];
const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));

describe("first build and versions", () => {
  it("the same note first built twice at once via Promise.all -> exactly one row per section_id, one state row", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const blocks = [{ id: "p", text: "top" }, { id: "h", type: "heading", text: "H" }, { id: "q", text: "body" }];
    await seedNoteState(db, n.id, searchDoc(blocks), 1);
    const ex = extractOf(blocks);
    const out = await Promise.all([writeSearchIndex(db, n.id, 1, ex), writeSearchIndex(db, n.id, 1, ex)]);
    expect(out.sort()).toEqual(["unchanged", "written"]);
    expect((await indexRows(db, n.id)).map(r => r.sectionId)).toEqual(["_top", "h"]);
    expect(await db.select().from(noteSearchState).where(eq(noteSearchState.noteId, n.id))).toHaveLength(1);
  });

  it("called with an old sourceVersion -> stale, tables unchanged, no leftover state row after a first build", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V2), 2);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("stale");
    expect(await stateRow(db, n.id)).toBeUndefined();
    expect(await indexRows(db, n.id)).toEqual([]);
  });

  it("no note_states row -> stale; note does not exist -> gone", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("stale");
    expect(await writeSearchIndex(db, "00000000-0000-4000-8000-0000000000aa", 1, extractOf(V1))).toBe("gone");
  });

  it("a new version with the same content -> unchanged only advances source_version; changed content -> written replaces the whole note", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("written");
    await setNoteState(db, n.id, searchDoc(V1), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V1))).toBe("unchanged");
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
    await setNoteState(db, n.id, searchDoc(V2), 3);
    expect(await writeSearchIndex(db, n.id, 3, extractOf(V2))).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 3, indexedUnits: "version two bravo".length, capped: false });
  });

  it("empty content (0 rows) -> written, one state row, 0 section rows, indexed_units 0, not capped; content later is still written", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const empty = [{ id: "p" }, { id: "q" }];
    await seedNoteState(db, n.id, searchDoc(empty), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(empty))).toBe("written");
    expect(await indexRows(db, n.id)).toEqual([]);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 1, indexedUnits: 0, capped: false });
    await setNoteState(db, n.id, searchDoc(V1), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V1))).toBe("written");
    expect(await indexRows(db, n.id)).toHaveLength(1);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 2, indexedUnits: "version one alpha".length, capped: false });
  });

  it("2001 headings -> 2000 rows (4 INSERT statements) get written, ord is contiguous, state row is capped and indexed_units equals the sum of row bodies", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const blocks = heads(2001);
    await seedNoteState(db, n.id, searchDoc(blocks), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(blocks))).toBe("written");
    const rows = await indexRows(db, n.id);
    expect(rows).toHaveLength(2000);
    expect(rows.at(-1)!.ord).toBe(2000);
    const units = rows.reduce((s, r) => s + r.body.length, 0);
    expect(units).toBeGreaterThan(0);
    expect(await stateRow(db, n.id)).toMatchObject({ indexedUnits: units, capped: true });
  });

  it("rows unchanged, only capped flips -> written (not unchanged) and the state row's capped follows (2000 vs 2001 paragraphs; empty note vs one with an empty-id container)", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(heads(2000)), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(heads(2000)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ capped: false });
    await setNoteState(db, n.id, searchDoc(heads(2001)), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(heads(2001)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 2, capped: true });
    await setNoteState(db, n.id, searchDoc(heads(2000)), 3);
    expect(await writeSearchIndex(db, n.id, 3, extractOf(heads(2000)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 3, capped: false });

    const m = await seedNote(db, { ownerId: u.id });
    const empty = [{ id: "p" }];
    const badId = [{ id: "p" }, { id: "", text: "x" }];
    await seedNoteState(db, m.id, searchDoc(empty), 1);
    expect(await writeSearchIndex(db, m.id, 1, extractOf(empty))).toBe("written");
    await setNoteState(db, m.id, searchDoc(badId), 2);
    expect(await writeSearchIndex(db, m.id, 2, extractOf(badId))).toBe("written");
    expect(await indexRows(db, m.id)).toEqual([]);
    expect(await stateRow(db, m.id)).toMatchObject({ sourceVersion: 2, indexedUnits: 0, capped: true });
  });
});

describe("lock order against note deletion", () => {
  it("permanent delete while the index transaction holds the state-row lock (#181: DELETE only moves to trash; hard delete goes through purgeTrashedNotesInTx) -> permanent delete waits on the notes row and completes after release, neither table has the note's rows", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await markTrashed(db.$client, n.id, u.id); // index writing ignores deleted_at (includes): trashed notes are still indexed
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1)); // the state row exists: the ON CONFLICT DO NOTHING insert does not trigger an FK check
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const gate = makeGate();
    // Stop after the state-row lock is taken, i.e. holding notes KEY SHARE and the state row FOR UPDATE. Without the initial
    // notes KEY SHARE: this tx holds the state-row lock, DELETE holds the notes row, DELETE's cascade has locked the sections rows
    // and waits on the state row; after release the sections delete waits on DELETE - a real cycle (40P01, closing at
    // the index writer's `delete from note_search_sections` against `deleteNotesInTx`, which permanent delete calls). Stopping before the
    // state-row lock would also go red (no lock held -> DELETE is not blocked -> "settled"), but
    // that only proves "not blocked" and never reaches the deadlock path above.
    const w = writeSearchIndex(db, n.id, 2, extractOf(V2), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    const purge = db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [n.id], by: u.id }));
    expect(await waitForBlockedOrSettled(db.$client, purge)).toBe("blocked");
    gate.open();
    expect(await w).toBe("written");
    expect((await purge).done).toEqual([n.id]);
    expect(await indexRows(db, n.id)).toEqual([]);
    expect(await stateRow(db, n.id)).toBeUndefined();
  });

  it("reverse: delete takes the notes row first -> the index transaction blocks at its first lock and returns gone after the delete commits", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("delete from notes where id = $1", [n.id]);
      const w = writeSearchIndex(db, n.id, 1, extractOf(V1));
      expect(await waitForBlockedOrSettled(db.$client, w)).toBe("blocked");
      await holder.query("commit");
      expect(await w).toBe("gone");
    } finally {
      await holder.end();
    }
    expect(await stateRow(db, n.id)).toBeUndefined(); // the placeholder row disappears with the rollback (gone goes through an exception)
  });
});

describe("backfill interleaved with live persist (two named stop points)", () => {
  it("case A (beforeStateLockForTest): backfill B stops before taking the state-row lock; live persist writes V+1 and finishes indexing; release B -> stale, table has V+1; a later bump with the same content changes nothing", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const gate = makeGate();
    const b = writeSearchIndex(db, n.id, 1, extractOf(V1), { hooks: { beforeStateLockForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, searchDoc(V2), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V2))).toBe("written"); // L: B holds only KEY SHARE, so L is not blocked
    gate.open();
    expect(await b).toBe("stale");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    await setNoteState(db, n.id, searchDoc(V2), 3);
    expect(await bumpSearchIndexVersion(db, n.id, 3, extractOf(V2).contentHash)).toBe(1);
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(3);
  });

  it("case B (afterVersionReadForTest): B holds the state-row lock and has read V; live persist writes V+1 and its index transaction L waits on the second lock; release B -> B writes V, then L writes V+1", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const gate = makeGate();
    const b = writeSearchIndex(db, n.id, 1, extractOf(V1), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const l = writeSearchIndex(db, n.id, 2, extractOf(V2));
    expect(await waitForBlockedOrSettled(db.$client, l)).toBe("blocked");
    gate.open();
    expect(await b).toBe("written");
    expect(await l).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
  });

  it("case C: note_states.version written backwards (below the state row's source_version) -> still written, one warn", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 5);
    await writeSearchIndex(db, n.id, 5, extractOf(V1));
    await setNoteState(db, n.id, searchDoc(V2), 2); // manual SQL outside the app (the index was not deleted per the restore runbook)
    const { log, warns } = captureLog();
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V2), { log })).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ noteId: n.id, stateSourceVersion: 5, noteStateVersion: 2 });
  });
});

describe("rollback on the normal write path", () => {
  it("afterWriteForTest throws after the INSERT and the state-row UPDATE -> the error surfaces, old index rows and state row are unchanged", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1));
    const before = await stateRow(db, n.id);
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const boom = async (): Promise<void> => { throw new Error("after-write boom"); };
    await expect(writeSearchIndex(db, n.id, 2, extractOf(V2), { hooks: { afterWriteForTest: boom } })).rejects.toThrow("after-write boom");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version one alpha"]);
    expect(await stateRow(db, n.id)).toEqual(before);
  });
});

describe("bumpSearchIndexVersion", () => {
  it("advances only when hash/extractor match and source_version is smaller; otherwise returns 0", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1));
    const h = extractOf(V1).contentHash;
    expect(await bumpSearchIndexVersion(db, n.id, 2, "deadbeef")).toBe(0);
    expect(await bumpSearchIndexVersion(db, n.id, 1, h)).toBe(0);
    expect(await bumpSearchIndexVersion(db, n.id, 2, h)).toBe(1);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
    await db.execute(sql`update note_search_state set extractor_version = 0 where note_id = ${n.id}::uuid`);
    expect(await bumpSearchIndexVersion(db, n.id, 3, h)).toBe(0);
  });
});
