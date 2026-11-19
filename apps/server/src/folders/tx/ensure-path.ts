/** Callers hold the space's structure lock (rename and create take it too), so a name can't be taken between lookup and INSERT. */
import { and, asc, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import type { FolderSpace } from "../space.js";
import { folderSpaceWhere } from "../sql.js";

/** Depth and count limits are not checked: restore must not fail on them. */
export async function ensureFolderPathInTx(tx: Tx, space: FolderSpace, segments: readonly string[], by: string): Promise<string> {
  if (segments.length === 0) throw new Error("ensureFolderPathInTx: segments 不得為空");
  let parentId: string | null = null;
  for (const seg of segments) {
    // lower() matches the sibling unique index, so a miss here means the INSERT can't collide; segments must already be NFC.
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
