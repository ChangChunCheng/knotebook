// The `.transaction(` callback must be exactly `runNoteSearchInTx(tx, input)` with no second argument (test/unit/tx-nested-pool-borrow-structure.test.ts); the isolation level is in the body's first statement.
import type { Db } from "../db/index.js";
import type { SearchMatchRow } from "./search-sql.js";
import { runNoteSearchInTx, type NoteSearchInput, type NoteSearchResult } from "./tx/search-query.js";

export async function searchNotesForUser(db: Db, input: NoteSearchInput): Promise<NoteSearchResult> {
  return db.transaction(tx => runNoteSearchInTx(tx, input));
}

export function groupMatchesByNote(matches: SearchMatchRow[]): Map<string, SearchMatchRow[]> {
  const out = new Map<string, SearchMatchRow[]>();
  for (const m of matches) {
    const list = out.get(m.note_id);
    if (list) list.push(m);
    else out.set(m.note_id, [m]);
  }
  return out;
}
