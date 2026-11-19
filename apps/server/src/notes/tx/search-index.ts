/**
 * Statement order is a contract. Notes KEY SHARE first: when the state row already exists, the upsert doesn't insert (no FK check), so without this the transaction would hold the state row while DELETE notes' cascade locks this note's sections rows then waits for the state row, and this transaction deleting old sections waits on the DELETE: a cycle (40P01, victim is the user's DELETE; pinned by `search-index-write.test.ts`). With notes KEY SHARE the DELETE waits on the notes row and never reaches the sections.
 * Then the state-row placeholder `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` (concurrent index transactions for one note queue here; FOR UPDATE alone would let both see no row). Read `note_states.version` only after holding the state-row lock (READ COMMITTED takes a snapshot per statement): reading first would let backfill overwrite a newer index with an older one (tested). `source_version > version` only happens if note_states was written backwards outside the app: write anyway and report `regressed` for a warn.
 * Missing or different `note_states` version → `stale`; same hash and extractor version → only `source_version` advances (`unchanged`); otherwise the rows are replaced in 500-row INSERTs (none when empty) → `written`. Skips are exceptions so drizzle rolls back the placeholder; `writeSearchIndex` catches them, the copy transaction doesn't (the whole copy fails).
 * Lock order: notes KEY SHARE → note_search_state row → note_search_sections rows.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteSearchSections, noteSearchState, noteStates, notes } from "../../db/schema.js";
import type { SearchExtract } from "../search-text.js";

export interface SearchIndexInput {
  noteId: string;
  sourceVersion: number;
  extract: SearchExtract;
}

export interface SearchIndexHooks {
  beforeStateLockForTest?(): Promise<void>;
  afterVersionReadForTest?(): Promise<void>;
  afterWriteForTest?(): Promise<void>;
}

export class SearchIndexSkip extends Error {
  constructor(readonly reason: "gone" | "stale") {
    super(`search index skipped: ${reason}`);
    this.name = "SearchIndexSkip";
  }
}

export interface SearchIndexTxResult {
  outcome: "written" | "unchanged";
  regressed: { stateSourceVersion: number; noteStateVersion: number } | null;
}

const INSERT_BATCH = 500;

export async function replaceNoteSearchIndexInTx(tx: Tx, input: SearchIndexInput, hooks?: SearchIndexHooks): Promise<SearchIndexTxResult> {
  const { noteId, sourceVersion, extract } = input;
  const [note] = await tx.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId)).for("key share");
  if (!note) throw new SearchIndexSkip("gone");
  await hooks?.beforeStateLockForTest?.();
  await tx
    .insert(noteSearchState)
    .values({ noteId, extractorVersion: 0, sourceVersion: -1, contentHash: "", indexedUnits: 0, capped: false })
    .onConflictDoNothing({ target: noteSearchState.noteId });
  const [state] = await tx
    .select({ sourceVersion: noteSearchState.sourceVersion, contentHash: noteSearchState.contentHash, extractorVersion: noteSearchState.extractorVersion })
    .from(noteSearchState)
    .where(eq(noteSearchState.noteId, noteId))
    .for("update");
  const [current] = await tx.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
  await hooks?.afterVersionReadForTest?.();
  if (!current || current.version !== sourceVersion) throw new SearchIndexSkip("stale");
  const regressed = state!.sourceVersion > current.version ? { stateSourceVersion: state!.sourceVersion, noteStateVersion: current.version } : null;

  if (state!.contentHash === extract.contentHash && state!.extractorVersion === extract.extractorVersion) {
    await tx.update(noteSearchState).set({ sourceVersion, indexedAt: sql`now()` }).where(eq(noteSearchState.noteId, noteId));
    return { outcome: "unchanged", regressed };
  }

  await tx.delete(noteSearchSections).where(and(eq(noteSearchSections.noteId, noteId), eq(noteSearchSections.sourceKind, "note")));
  for (let i = 0; i < extract.rows.length; i += INSERT_BATCH) {
    await tx.insert(noteSearchSections).values(
      extract.rows.slice(i, i + INSERT_BATCH).map(r => ({ noteId, sectionId: r.sectionId, ord: r.ord, heading: r.heading, body: r.body })),
    );
  }
  await tx
    .update(noteSearchState)
    .set({
      extractorVersion: extract.extractorVersion,
      sourceVersion,
      contentHash: extract.contentHash,
      indexedUnits: extract.indexedUnits,
      capped: extract.capped,
      indexedAt: sql`now()`,
    })
    .where(eq(noteSearchState.noteId, noteId));
  await hooks?.afterWriteForTest?.();
  return { outcome: "written", regressed };
}
