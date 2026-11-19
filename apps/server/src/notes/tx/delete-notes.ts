/**
 * Lock order (#188): notes `FOR UPDATE` (by id ascending) first, then `DELETE uploads … RETURNING`. An upload transaction reads the note `FOR KEY SHARE`, which conflicts with `FOR UPDATE`, so an upload racing the delete reads 0 rows and 404s instead of committing between RETURNING and DELETE notes (its row would be cascaded away but missing from the returned ids, orphaning the disk file). The old order (uploads first) cycled with `deleteGroupWithNotesInTx` (40P01); now both lock notes first. `deleteGroupWithNotesInTx` already holds FOR UPDATE on the same rows (relocking is free). This transaction doesn't touch groups, so it can't cycle with move or transfer/delete-all.
 * Child tables are ON DELETE CASCADE; uploads are deleted explicitly first to get their ids, and files are deleted by the caller after commit (a rollback can't restore files).
 */
import { asc, inArray } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";

export async function deleteNotesInTx(tx: Tx, noteIds: readonly string[]): Promise<string[]> {
  const ids = [...noteIds];
  await tx.select({ id: notes.id }).from(notes).where(inArray(notes.id, ids)).orderBy(asc(notes.id)).for("update");
  const deleted = await tx.delete(uploads).where(inArray(uploads.noteId, ids)).returning({ id: uploads.id });
  await tx.delete(notes).where(inArray(notes.id, ids));
  return deleted.map(u => u.id);
}
