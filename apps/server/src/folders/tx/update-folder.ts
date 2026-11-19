/**
 * A move-only update reads the folder without FOR UPDATE: UPDATE of `parent_id` takes NO KEY UPDATE and needn't block placements.
 * No changed value → no UPDATE (`changed: false`). A sibling-name 23505 maps to 409 `folder_name_taken`.
 * Callers must use READ COMMITTED (see `lock.ts`).
 */
import { eq, sql } from "drizzle-orm";
import { FOLDER_DEPTH_MAX, type FolderPermissionsDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import {
  FOLDER_CROSS_SPACE_MESSAGE,
  FOLDER_CYCLE_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_TOO_DEEP_MESSAGE,
} from "../messages.js";
import type { FolderRow } from "../queries.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../space.js";
import { folderAncestorIdsSql, folderDepthSql, subtreeHeightSql } from "../sql.js";
import { folderAccessInTx, lockFolderInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "./lock.js";

export interface UpdateFolderInput {
  by: string;
  folderId: string;
  space: FolderSpace;
  /** Must already be normalized with `normalizeFolderName`; undefined = no rename. */
  name?: string;
  parentId?: string | null;
  lockTimeoutMs: number;
}

export async function updateFolderInTx(
  tx: Tx,
  input: UpdateFolderInput,
  hook?: GroupTestHook,
): Promise<{ row: FolderRow; permissions: FolderPermissionsDto; changed: boolean }> {
  const { space } = input;
  const notFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const hookCtx: GroupHookCtx = { folderId: input.folderId, ...(space.kind === "group" ? { groupId: space.groupId } : {}) };

  if (space.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [space.groupId]);
    if (!present.has(space.groupId)) throw notFound();
  }
  await lockFolderSpacesInTx(tx, [space], { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx });

  const self = input.name !== undefined
    ? await lockFolderInTx(tx, input.folderId, "update")
    : (await tx.select().from(folders).where(eq(folders.id, input.folderId)))[0];
  if (!self || !sameFolderSpace(folderSpaceOfRow(self), space)) throw notFound();
  const access = await folderAccessInTx(tx, input.by, self);
  if (access === null) throw notFound();

  // Depth isn't checked on a no-op move or rename: an over-deep tree produced by a transfer must stay renamable.
  const moving = input.parentId !== undefined && input.parentId !== self.parentId;
  if (moving && input.parentId !== null && input.parentId !== undefined) {
    const parent = await lockFolderInTx(tx, input.parentId, "key share");
    if (!parent || (await folderAccessInTx(tx, input.by, parent)) === null) throw notFound();
    if (!sameFolderSpace(folderSpaceOfRow(parent), space)) throw new TxAbort(400, "folder_cross_space", FOLDER_CROSS_SPACE_MESSAGE);
  }
  if (!access.permissions.manage) throw new TxAbort(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  if (moving) {
    let parentDepth = 0;
    if (input.parentId !== null && input.parentId !== undefined) {
      const cycle = await tx.execute<{ hit: boolean }>(
        sql`select exists (${folderAncestorIdsSql(input.parentId)} where kf_anc_ids.id = ${self.id}::uuid) as hit`,
      );
      if (cycle.rows[0]?.hit) throw new TxAbort(409, "folder_cycle", FOLDER_CYCLE_MESSAGE);
      parentDepth = Number((await tx.execute<{ d: number | null }>(sql`select ${folderDepthSql(input.parentId)} as d`)).rows[0]?.d ?? 0);
    }
    const height = Number((await tx.execute<{ h: number | null }>(sql`select ${subtreeHeightSql(self.id)} as h`)).rows[0]?.h ?? 1);
    if (parentDepth + height > FOLDER_DEPTH_MAX) throw new TxAbort(409, "folder_too_deep", FOLDER_TOO_DEEP_MESSAGE);
  }

  const set: { name?: string; parentId?: string | null } = {
    ...(input.name !== undefined && input.name !== self.name ? { name: input.name } : {}),
    ...(moving ? { parentId: input.parentId ?? null } : {}),
  };
  if (Object.keys(set).length === 0) return { row: self, permissions: access.permissions, changed: false };
  const [row] = await tx.update(folders).set(set).where(eq(folders.id, self.id)).returning();
  return { row: row!, permissions: access.permissions, changed: true };
}
