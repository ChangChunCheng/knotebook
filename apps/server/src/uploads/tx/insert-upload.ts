/** The note is locked `FOR KEY SHARE` explicitly before the space lock, and the space is the one read inside the transaction (the precheck may predate a move). The route unlinks the file if this throws. */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { spaceOfNote } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";

export interface InsertUploadInput {
  id: string;
  /** Already through `UUID_RE` and lowercased. */
  noteId: string;
  uploaderId: string;
  mime: string;
  size: number;
  lockTimeoutMs: number;
}

export async function insertUploadInTx(tx: Tx, input: InsertUploadInput, hook?: GroupTestHook): Promise<void> {
  const [note] = await tx
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("key share");
  // Trashing takes `FOR UPDATE` first, which conflicts with this KEY SHARE; if it commits first the re-evaluated `deleted_at IS NULL` fails and this is a 404.
  if (!note) throw new TxAbort(404, "not_found", "No note with that id.");
  await assertSpaceRoomInTx(tx, spaceOfNote(note), input.size, { lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { noteId: input.noteId } });
  // charged_to_id = uploader, also for personal notes (`notes/tx/move.ts` overwrites it on a move into a group).
  await tx.insert(uploads).values({ id: input.id, noteId: input.noteId, uploaderId: input.uploaderId, chargedToId: input.uploaderId, mime: input.mime, size: input.size });
}
