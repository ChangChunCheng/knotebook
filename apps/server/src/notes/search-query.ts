// The `.transaction(` callback must be exactly `runNoteSearchInTx(tx, input)` with no second argument (test/unit/tx-nested-pool-borrow-structure.test.ts); the isolation level is in the body's first statement.
import type { Db } from "../db/index.js";
import type { SearchMatchRow } from "./search-sql.js";
import type { SnippetWindow } from "./search-snippet.js";
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

/** The snippet window of a match; for several keywords the hit is the longest keyword starting at the earliest position. */
export function snippetWindowOf(m: SearchMatchRow, terms: readonly string[]): SnippetWindow {
  let qlen = Array.from(terms[0]!).length;
  if (m.ps !== undefined) {
    qlen = 0;
    m.ps.forEach((p, i) => {
      if (p === m.p) qlen = Math.max(qlen, Array.from(terms[i]!).length);
    });
  }
  return { win: m.win, lead: m.p - m.win_start, qlen, winStart: m.win_start, bodyLen: m.body_len };
}

/** `undefined` for a one-keyword query, so its replies keep their pre-#399 shape. */
export function matchedTermsOf(flags: readonly (boolean | number)[] | undefined, terms: readonly string[]): string[] | undefined {
  if (flags === undefined) return undefined;
  return terms.filter((_, i) => flags[i] === true || (typeof flags[i] === "number" && flags[i] > 0));
}
