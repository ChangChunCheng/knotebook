/**
 * Path-based folder rebuild used by restore. Takes only `tx` and plain data.
 * Callers (`restoreNotesInTx`) must hold the space's structure lock; rename and create take the same lock, so a name can't be taken between "not found" and INSERT (no 23505).
 */
import { and, asc, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import type { FolderSpace } from "../space.js";
import { folderSpaceWhere } from "../sql.js";

/**
 * Walks root to leaf: per level, selects the folder under the parent with `lower(name) = lower($seg)` (the same comparison as the
 * sibling unique index), lowest id first, and INSERTs it (`created_by = by`) if missing. Segment names must already be NFC.
 * Depth and count limits are **not** checked (restore must not fail on them). `segments` must be non-empty. Returns the leaf id.
 */
export async function ensureFolderPathInTx(tx: Tx, space: FolderSpace, segments: readonly string[], by: string): Promise<string> {
  if (segments.length === 0) throw new Error("ensureFolderPathInTx: segments 不得為空");
  let parentId: string | null = null;
  for (const seg of segments) {
    const [hit]: Array<{ id: string }> = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(
        folderSpaceWhere(space),
        sql`${folders.parentId} is not distinct from ${parentId}::uuid`,
        sql`lower(${folders.name}) = lower(${seg})`,
      ))
      .orderBy(asc(folders.id))
      .limit(1);
    if (hit) {
      parentId = hit.id;
      continue;
    }
    const [row]: Array<{ id: string }> = await tx
      .insert(folders)
      .values({
        kind: space.kind,
        ownerId: space.kind === "group" ? null : space.ownerId,
        groupId: space.kind === "group" ? space.groupId : null,
        parentId,
        name: seg,
        createdBy: by,
      })
      .returning({ id: folders.id });
    parentId = row!.id;
  }
  return parentId!;
}
