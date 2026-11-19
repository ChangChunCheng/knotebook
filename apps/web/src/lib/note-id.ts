/**
 * Compare ids case-insensitively: a wikilink `targetNoteId` in an old document may be stored
 * uppercase (migration 0020 lowercases `link_target_ids`), and `===` would misjudge it as broken.
 */
export function sameNoteId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
