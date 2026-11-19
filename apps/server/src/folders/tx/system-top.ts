/** Caller holds the recipient's structure lock (rename/create/rebuild take it too), so probing can't lose a name race. */
import { and, isNull, sql } from "drizzle-orm";
import { FOLDERS_PER_SPACE_MAX } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import { folderNameWithSuffix } from "../names.js";
import { folderSpaceWhere } from "../sql.js";

/** Gives up after `FOLDERS_PER_SPACE_MAX + 2` tries (practically unreachable: system-created folders skip the count limit, but the root would need that many same-base names). Depth and count limits aren't checked. Returns the name actually written, suffix included. */
export async function createSystemTopFolderInTx(tx: Tx, input: { ownerId: string; baseName: string; by: string }): Promise<{ id: string; name: string }> {
  for (let n = 1; n <= FOLDERS_PER_SPACE_MAX + 2; n++) {
    const name = folderNameWithSuffix(input.baseName, n);
    // lower() matches the sibling unique index; baseName must already have gone through `normalizeFolderNameLoose`.
    const [taken] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(
        folderSpaceWhere({ kind: "personal", ownerId: input.ownerId }),
        isNull(folders.parentId),
        sql`lower(${folders.name}) = lower(${name})`,
      ))
      .limit(1);
    if (taken) continue;
    const [row] = await tx
      .insert(folders)
      .values({ kind: "personal", ownerId: input.ownerId, groupId: null, parentId: null, name, createdBy: input.by })
      .returning({ id: folders.id, name: folders.name });
    return { id: row!.id, name: row!.name };
  }
  throw new Error("createSystemTopFolderInTx: 尾碼探測用完");
}
