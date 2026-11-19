// First write: `UPDATE notes SET links_clock = $clock WHERE links_clock <= $clock`: 0 rows = a stale submission lost LWW, a no-op. `<=` (not `<`) deliberately lets a same-clock resend take effect, so retries and concurrent deliveries of one edit overwrite correctly. Then one batch authorization query (`union`, not `unionAll`, so a note matching several branches isn't counted twice) decides all linkable targets at once instead of `resolveRole` per target. The FK-race retry and 40001/40P01 → busy live in `writeNoteLinks` (`notes/links.ts`). Finally the set is replaced: new rows inserted (`onConflictDoNothing`), rows not in it deleted; an empty set deletes all.
import { and, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, noteLinks, noteShares, notes } from "../../db/schema.js";

export interface WriteLinksInput {
  sourceNoteId: string;
  userId: string;
  /** Already through `normalizeLinkTargets` (deduped, lowercased, self removed); empty clears all links. */
  targetIds: string[];
  clock: number;
}

export async function writeLinksInTx(
  tx: Tx,
  input: WriteLinksInput,
  beforeLinkWrite?: () => Promise<void>,
): Promise<"applied" | "noop"> {
  const [updated] = await tx
    .update(notes)
    .set({ linksClock: input.clock })
    .where(and(eq(notes.id, input.sourceNoteId), lte(notes.linksClock, input.clock)))
    .returning({ id: notes.id });
  if (!updated) return "noop";

  let targets: string[] = [];
  if (input.targetIds.length > 0) {
    const ownedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.ownerId, input.userId), inArray(notes.id, input.targetIds)));
    // JOIN notes for `group_id`: leftover share rows on group notes grant no link right.
    const sharedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, input.userId)))
      .where(and(inArray(notes.id, input.targetIds), isNull(notes.groupId)));
    // A member writing `[[group note]]` in their own note needs the read flag.
    const groupedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, input.userId)))
      .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
      .where(inArray(notes.id, input.targetIds));
    const rows = await union(ownedSelect, sharedSelect, groupedSelect);
    targets = rows.map(row => row.id);
  }

  await beforeLinkWrite?.();

  if (targets.length > 0) {
    await tx
      .insert(noteLinks)
      .values(targets.map(targetNoteId => ({ sourceNoteId: input.sourceNoteId, targetNoteId })))
      .onConflictDoNothing();
    await tx.delete(noteLinks).where(and(eq(noteLinks.sourceNoteId, input.sourceNoteId), notInArray(noteLinks.targetNoteId, targets)));
  } else {
    await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, input.sourceNoteId));
  }
  return "applied";
}
