import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listVisibleFoldersPage } from "../folders/queries.js";
import type { FolderServiceDeps } from "../folders/service.js";
import { folderForModel } from "./folder-fields.js";
import { FOLDER_NOT_FOUND_MESSAGE } from "./folder-messages.js";
import { toolError, toolResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

export function folderServiceDeps(ctx: McpToolCtx): FolderServiceDeps {
  return {
    db: ctx.db,
    collabHooks: ctx.collabHooks,
    storageLockTimeoutMs: ctx.storageLockTimeoutMs,
    groupTestHook: ctx.groupTestHook,
    limiters: { folder: ctx.limiters.folder },
  };
}

/** A miss means the folder was deleted between commit and re-read → `not_found`. */
export async function folderReply(ctx: McpToolCtx, folderId: string): Promise<CallToolResult> {
  const page = await listVisibleFoldersPage(ctx.db, ctx.userId, { ids: [folderId], limit: 1, after: null });
  const row = page.rows[0];
  if (row === undefined) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
  return toolResult({ folder: folderForModel(row) });
}
