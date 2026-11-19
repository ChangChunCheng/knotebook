import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { folders } from "../db/schema.js";
import type { DbOrTx } from "../db/tx.js";
import type { FolderAccess } from "../folders/queries.js";
import { folderPathJsonSql } from "../folders/sql.js";
import { noNul } from "../notes/schemas.js";
import { UUID_RE } from "../notes/service.js";
import { MCP_FOLDER_NAME_MAX, MCP_FOLDER_PATH_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "./limits.js";

export const FOLDER_ID = z.string().regex(UUID_RE).refine(noNul).transform(s => s.toLowerCase());

export const folderRefSchema = z.object({
  id: z.string(),
  name: z.string().max(MCP_FOLDER_NAME_MAX),
  nameTruncated: z.literal(true).optional(),
});
export type FolderRefForModel = z.infer<typeof folderRefSchema>;

export function folderRefForModel(id: string, name: string): FolderRefForModel {
  const cut = truncateText(name, MCP_FOLDER_NAME_MAX);
  return { id, name: cut.text, ...(cut.truncated ? { nameTruncated: true as const } : {}) };
}

/** personal/shared omit the owner id (only the user sees it, like REST `toFolderSpaceDto`); group names are cut at the group `owner.name` limit (`MCP_TEXT_MAX`). */
export const folderForModelSchema = z.object({
  id: z.string(),
  name: z.string().max(MCP_FOLDER_NAME_MAX),
  nameTruncated: z.literal(true).optional(),
  parentId: z.string().nullable(),
  space: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("personal") }),
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("group"),
      groupId: z.string(),
      groupName: z.string().max(MCP_TEXT_MAX),
      groupNameTruncated: z.literal(true).optional(),
    }),
  ]),
  path: z.array(z.string().max(MCP_FOLDER_NAME_MAX)),
  pathTruncated: z.literal(true).optional(),
});
export type FolderForModel = z.infer<typeof folderForModelSchema>;

export function folderForModel(row: { access: FolderAccess; path: string[]; groupName: string | null }): FolderForModel {
  const f = row.access.folder;
  const sp = row.access.space;
  const name = truncateText(f.name, MCP_FOLDER_NAME_MAX);
  let space: FolderForModel["space"];
  if (sp.kind === "group") {
    const g = truncateText(row.groupName ?? "", MCP_TEXT_MAX);
    space = { kind: "group", groupId: sp.groupId, groupName: g.text, ...(g.truncated ? { groupNameTruncated: true as const } : {}) };
  } else {
    space = { kind: sp.kind };
  }
  const path = truncateFolderPath(row.path);
  return {
    id: f.id,
    name: name.text,
    ...(name.truncated ? { nameTruncated: true as const } : {}),
    parentId: f.parentId,
    space,
    path: path.path,
    ...(path.truncated ? { pathTruncated: true as const } : {}),
  };
}

export function folderPathCost(names: readonly string[]): number {
  if (names.length === 0) return 0;
  let cost = names.length - 1;
  for (const name of names) cost += escapedLength(name) + 2;
  return cost;
}

/** A cut segment is at most 82 (80 plus quotes), so the one segment always kept is within the limit. */
export function truncateFolderPath(names: readonly string[]): { path: string[]; truncated: boolean } {
  const cuts = names.map(name => truncateText(name, MCP_FOLDER_NAME_MAX));
  let truncated = cuts.some(c => c.truncated);
  let path = cuts.map(c => c.text);
  while (path.length > 1 && folderPathCost(path) > MCP_FOLDER_PATH_MAX) {
    path = path.slice(1);
    truncated = true;
  }
  return { path, truncated };
}

/** No visibility check: callers pass a `viewerFolderId` already visible to the caller. */
export async function loadFolderNames(db: DbOrTx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, wanted));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

export async function loadFolderPath(db: DbOrTx, folderId: string): Promise<string[] | null> {
  const result = await db.execute<{ path: string[] | null }>(sql`select ${folderPathJsonSql(sql`${folderId}::uuid`)} as path`);
  return result.rows[0]?.path ?? null;
}
