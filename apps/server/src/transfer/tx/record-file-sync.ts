/**
 * Takes only `tx` and plain data; the caller's `.transaction(` callback is one call to this.
 * `created_at` is `now() + i microseconds` so `listEdits` ordering and trimming are
 * deterministic for this request's rows. All three steps share one transaction (else the
 * INSERT would stay without the base being written). Returns the ids of rows that survive
 * the trim (beyond 100 regions, earlier rows of this request are trimmed). The trim is per
 * note. Errors carrying content (`before_blocks`) are redacted by the caller outside the transaction.
 */
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { AI_EDITS_RETENTION } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { noteAiEdits, transferBases } from "../../db/schema.js";

export interface RecordFileSyncInput {
  noteId: string;
  baseKey: string;
  appliedBodySha: Buffer;
  /** In document order. */
  rows: Array<typeof noteAiEdits.$inferInsert>;
}

export async function recordFileSyncInTx(tx: Tx, input: RecordFileSyncInput): Promise<string[]> {
  let ids: string[] = [];
  if (input.rows.length > 0) {
    const inserted = await tx
      .insert(noteAiEdits)
      .values(input.rows.map((r, i) => ({ ...r, createdAt: sql`now() + ${i}::int * interval '1 microsecond'` })))
      .returning({ id: noteAiEdits.id });
    ids = inserted.map(r => r.id);
    const keep = await tx
      .select({ id: noteAiEdits.id })
      .from(noteAiEdits)
      .where(eq(noteAiEdits.noteId, input.noteId))
      .orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id))
      .limit(AI_EDITS_RETENTION);
    const kept = new Set(keep.map(k => k.id));
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, input.noteId), notInArray(noteAiEdits.id, [...kept])));
    ids = ids.filter(id => kept.has(id));
  }
  // `applied_edit_ids`: when the same file is re-sent, these rows are checked for having been reverted.
  await tx.update(transferBases).set({ appliedBodySha: input.appliedBodySha, appliedEditIds: ids, lastUsedAt: sql`now()` }).where(eq(transferBases.key, input.baseKey));
  return ids;
}
