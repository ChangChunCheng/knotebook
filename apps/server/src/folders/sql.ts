/**
 * SQL fragments for folders: built, never executed, and built fresh on every call. Each recursive CTE has its own name
 * (`kf_*`) so several can be combined in one statement. Cycles are rejected in application code under the structure lock,
 * not by the DB; every recursive CTE is also capped by `FOLDER_CTE_DEPTH_LIMIT`, so a cycle would still terminate.
 */
import { sql, type SQL } from "drizzle-orm";
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";
import { folders } from "../db/schema.js";
import type { FolderSpace } from "./space.js";

/**
 * Max levels a recursive CTE walks (including the start row). The deepest legitimate tree is `FOLDER_DEPTH_MAX + 1`
 * (group deletion adds one new top level; rebuild-from-path never exceeds the snapshot length, which is why the cap holds although
 * `ensureFolderPathInTx` skips depth checks); 4x leaves ample headroom.
 * ⚠ Hitting the cap silently truncates the result (path loses its root end, subtree loses deep descendants). That only
 * happens on a cycle or an over-deep tree, so callers such as folder deletion must not assume a truncated subtree is complete.
 */
export const FOLDER_CTE_DEPTH_LIMIT = FOLDER_DEPTH_MAX * 4;
const LIMIT = (): SQL => sql.raw(String(FOLDER_CTE_DEPTH_LIMIT));

/**
 * Outer note `folder_id` reference. Correlated subqueries must spell the table name: drizzle 0.44 renders a column
 * interpolated into a single-table SELECT as a bare `"folder_id"` (a single-table UPDATE keeps the table name).
 */
export const NOTES_FOLDER_ID = (): SQL => sql.raw('"notes"."folder_id"');

/** Root-to-leaf name array as jsonb; NULL when `outer` is NULL (root level). Correlated recursive CTE, usable in `UPDATE notes SET trash_folder_path = …`. */
export function folderPathJsonSql(outer: SQL): SQL<string[] | null> {
  return sql<string[] | null>`(with recursive kf_up(id, parent_id, name, d) as (
    select f.id, f.parent_id, f.name, 0 from ${folders} f where f.id = ${outer}
    union all
    select p.id, p.parent_id, p.name, kf_up.d + 1 from ${folders} p join kf_up on p.id = kf_up.parent_id where kf_up.d + 1 < ${LIMIT()}
  ) select jsonb_agg(kf_up.name order by kf_up.d desc) from kf_up)`;
}

/** Ids of `rootId` and all its descendants, as `select id from (…)` for use in `IN (…)`. */
export function subtreeFolderIdsSql(rootId: string): SQL {
  return sql`select kf_sub_ids.id from (with recursive kf_sub(id, lvl) as (
    select f.id, 1 from ${folders} f where f.id = ${rootId}::uuid
    union all
    select c.id, kf_sub.lvl + 1 from ${folders} c join kf_sub on c.parent_id = kf_sub.id where kf_sub.lvl < ${LIMIT()}
  ) select kf_sub.id from kf_sub) kf_sub_ids`;
}

/** Depth: a root-level folder = 1; NULL if the folder doesn't exist. */
export function folderDepthSql(folderId: string): SQL<number> {
  return sql<number>`(with recursive kf_depth(id, parent_id, d) as (
    select f.id, f.parent_id, 1 from ${folders} f where f.id = ${folderId}::uuid
    union all
    select p.id, p.parent_id, kf_depth.d + 1 from ${folders} p join kf_depth on p.id = kf_depth.parent_id where kf_depth.d < ${LIMIT()}
  ) select max(kf_depth.d) from kf_depth)`;
}

/** Subtree height: a lone folder = 1; NULL if the folder doesn't exist. */
export function subtreeHeightSql(rootId: string): SQL<number> {
  return sql<number>`(with recursive kf_height(id, h) as (
    select f.id, 1 from ${folders} f where f.id = ${rootId}::uuid
    union all
    select c.id, kf_height.h + 1 from ${folders} c join kf_height on c.parent_id = kf_height.id where kf_height.h < ${LIMIT()}
  ) select max(kf_height.h) from kf_height)`;
}

/** Ids of `folderId` and all its ancestors, as `select id from (…)` for use in `IN (…)`. */
export function folderAncestorIdsSql(folderId: string): SQL {
  return sql`select kf_anc_ids.id from (with recursive kf_anc(id, parent_id, lvl) as (
    select f.id, f.parent_id, 1 from ${folders} f where f.id = ${folderId}::uuid
    union all
    select p.id, p.parent_id, kf_anc.lvl + 1 from ${folders} p join kf_anc on p.id = kf_anc.parent_id where kf_anc.lvl < ${LIMIT()}
  ) select kf_anc.id from kf_anc) kf_anc_ids`;
}

export function folderSpaceWhere(space: FolderSpace): SQL {
  return space.kind === "group"
    ? sql`(${folders.kind} = 'group' and ${folders.groupId} = ${space.groupId}::uuid)`
    : sql`(${folders.kind} = ${space.kind} and ${folders.ownerId} = ${space.ownerId}::uuid)`;
}
