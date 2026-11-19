// `FOR SHARE` on `group_id` conflicts with the move transaction's `FOR UPDATE`; a non-NULL value (moved into a group after authorization) → 409.
import { and, eq, isNull } from "drizzle-orm";
import type { ShareRole } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { noteShares, notes } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";

export async function upsertShareInTx(
  tx: Tx,
  input: { noteId: string; targetUserId: string; role: ShareRole },
  hook?: GroupTestHook,
): Promise<void> {
  const [locked] = await tx.select({ groupId: notes.groupId }).from(notes).where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt))).for("share");
  if (!locked) throw new TxAbort(404, "not_found", "No note with that id.");
  if (locked.groupId !== null) throw new TxAbort(409, "note_in_group", "Group notes can't be shared with individual people. Add the person to the group instead.");
  await hook?.("share-group-checked", { noteId: input.noteId });
  await tx
    .insert(noteShares)
    .values({ noteId: input.noteId, userId: input.targetUserId, role: input.role })
    .onConflictDoUpdate({ target: [noteShares.noteId, noteShares.userId], set: { role: input.role } });
}
