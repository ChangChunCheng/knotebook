import type { NoteDto, NoteSearchHitDto, NoteSearchMatchDto } from "@knotebook/shared";

export interface MergedRow {
  note: NoteDto;
  titleHit: boolean;
  matches: NoteSearchMatchDto[];
}

/** Links and titles come from the `NoteDto` in the list (hits are cross-checked: a hit not in the list is dropped, so a renamed, moved or trashed old result can't link to an old path). A `matchedOn: "title"` hit has no snippet and forms no row of its own. */
export function mergeSearchRows(titleNotes: NoteDto[], hits: NoteSearchHitDto[], notes: NoteDto[]): MergedRow[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows = new Map<string, MergedRow>();
  for (const note of titleNotes) rows.set(note.id, { note, titleHit: true, matches: [] });
  for (const h of hits) {
    if (h.matchedOn === "title") continue;
    const listNote = byId.get(h.note.id);
    if (!listNote) continue;
    const existing = rows.get(listNote.id);
    if (existing) existing.matches = h.matches;
    else rows.set(listNote.id, { note: listNote, titleHit: false, matches: h.matches });
  }
  return Array.from(rows.values());
}

/** One row per matching paragraph (the server returns only the first hit per paragraph, at most 3 per note), or title-only. */
export type ResultItem =
  | { kind: "match"; note: NoteDto; match: NoteSearchMatchDto }
  | { kind: "title"; note: NoteDto };

/** A note matching in both title and body lists only its body rows, no extra title-only row. */
export function flattenRows(rows: MergedRow[]): ResultItem[] {
  return rows.flatMap((row): ResultItem[] =>
    row.matches.length === 0 ? [{ kind: "title", note: row.note }] : row.matches.map((match) => ({ kind: "match", note: row.note, match })),
  );
}
