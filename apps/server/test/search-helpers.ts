import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../src/db/index.js";
import { noteSearchSections, noteSearchState, noteStates } from "../src/db/schema.js";
import { extractForIndex, writeSearchIndex } from "../src/notes/search-index.js";
import type { SearchExtract } from "../src/notes/search-text.js";
import { seedNote } from "./group-helpers.js";
import { searchDoc, type Blk } from "./search-doc.js";

export async function seedNoteState(db: Db, noteId: string, doc: Y.Doc, version = 1): Promise<void> {
  await db.insert(noteStates).values({ noteId, ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version });
}

/** Stands in for `persistNoteState` (not under test): replaces note_states content and sets version. */
export async function setNoteState(db: Db, noteId: string, doc: Y.Doc, version: number): Promise<void> {
  await db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version }).where(eq(noteStates.noteId, noteId));
}

export const extractOf = (blocks: Blk[]): SearchExtract => extractForIndex(searchDoc(blocks));

export async function indexRows(db: Db, noteId: string): Promise<Array<{ sectionId: string; ord: number; heading: string; body: string; sourceKind: string }>> {
  return db
    .select({ sectionId: noteSearchSections.sectionId, ord: noteSearchSections.ord, heading: noteSearchSections.heading, body: noteSearchSections.body, sourceKind: noteSearchSections.sourceKind })
    .from(noteSearchSections)
    .where(eq(noteSearchSections.noteId, noteId))
    .orderBy(asc(noteSearchSections.ord));
}

export async function stateRow(db: Db, noteId: string) {
  const [row] = await db.select().from(noteSearchState).where(eq(noteSearchState.noteId, noteId));
  return row;
}

export async function noteStateVersion(db: Db, noteId: string): Promise<number | undefined> {
  const [row] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
  return row?.version;
}

export async function seedIndexedNote(db: Db, owner: { ownerId: string } | { groupId: string }, title: string, blocks: Blk[]): Promise<{ id: string; slug: string }> {
  const note = await seedNote(db, owner, { title });
  const doc = searchDoc(blocks);
  await seedNoteState(db, note.id, doc, 1);
  const outcome = await writeSearchIndex(db, note.id, 1, extractForIndex(doc));
  if (outcome !== "written") throw new Error(`seedIndexedNote：預期 written，得到 ${outcome}`);
  return note;
}

export async function waitIndexed(db: Db, noteId: string, pred: (bodies: string) => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [rows, st, v] = await Promise.all([indexRows(db, noteId), stateRow(db, noteId), noteStateVersion(db, noteId)]);
    if (st !== undefined && v !== undefined && st.sourceVersion === v && pred(rows.map(r => r.body).join("\n"))) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`waitIndexed 逾時（${ms}ms）：${noteId}`);
}

export function captureLog(): { log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }; warns: Array<{ obj: object; msg: string }>; infos: Array<{ obj: object; msg: string }> } {
  const warns: Array<{ obj: object; msg: string }> = [];
  const infos: Array<{ obj: object; msg: string }> = [];
  return { log: { warn: (obj, msg) => warns.push({ obj, msg }), info: (obj, msg) => infos.push({ obj, msg }) }, warns, infos };
}

/** A gate the test hook blocks on with `await gate.wait()`; `gate.open()` releases it and `reached` resolves on first entry. */
export function makeGate(): { wait: () => Promise<void>; open: () => void; reached: Promise<void> } {
  let open!: () => void;
  let enter!: () => void;
  const opened = new Promise<void>(r => (open = r));
  const reached = new Promise<void>(r => (enter = r));
  return { wait: async () => { enter(); await opened; }, open, reached };
}
