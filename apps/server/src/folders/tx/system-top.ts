/**
 * New top-level folder (system-chosen name) for group-deletion transfer. Takes only `tx` and plain data.
 * Callers (`transferGroupInTx`) must hold the structure lock of the recipient's personal space; rename, create and rebuild-from-path take the same lock, so probing and INSERT can't lose a name race (no 23505).
 */
import { and, isNull, sql } from "drizzle-orm";
import { FOLDERS_PER_SPACE_MAX } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import { folderNameWithSuffix } from "../names.js";
import { folderSpaceWhere } from "../sql.js";

/**
 * Creates a system folder at the recipient's personal root: tries `folderNameWithSuffix(baseName, n)` for n = 1, 2, …, comparing siblings with
 * SQL `lower()` (same as the sibling unique index), and INSERTs the first free name (`created_by = by`). `baseName` must already have passed `normalizeFolderNameLoose`.
 * Depth and count limits aren't checked. Tries at most `FOLDERS_PER_SPACE_MAX + 2` times, then throws (practically unreachable: it would need that many
 * same-base-name folders at the root). Returns the name actually written, suffix included.
 */
export async function createSystemTopFolderInTx(tx: Tx, input: { ownerId: string; baseName: string; by: string }): Promise<{ id: string; name: string }> {
  for (let n = 1; n <= FOLDERS_PER_SPACE_MAX + 2; n++) {
    const name = folderNameWithSuffix(input.baseName, n);
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
