/**
 * #181 spec §6.8.1 `list_trash`：呼叫者有垃圾桶權（D-W9）的垃圾桶筆記——與 `GET /api/trash` 同一支查詢（`trash/list.ts`），
 * 上限 `MCP_PAGE_MAX`、沒有分頁（PR-3d 才加 cursor）。讀取類：不做 scope 檢查、不扣桶（同 `list_notes`）。
 *
 * 輸出是物件不是陣列（spec §9-11）：之後只增不改——`cursor`／`nextCursor`／`pageCutShort`／每項 `folderPath`（folders spec §5.12）；
 * `truncated` 的名字與意思不改（今天＝「依筆數還有更多」）。
 * 回給模型的標題、刪除者名、群組名一律 `truncateText`（逃脫後計），只在真的截時才帶 `*Truncated: true`。
 * 本檔的 `deletedAt:`／`deletedBy:` 是 outputSchema 與 DTO 映射（讀取），已登記在 `trash-structure.test.ts` 守衛二。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TrashItemDto } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../../auth/tx/admin-site-settings.js";
import { listTrash as queryTrash, readTrashRetentionDays } from "../../trash/list.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, truncateText } from "../limits.js";
import { toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

export const LIST_TRASH_DESCRIPTION =
  "List the notes in your trash: your own personal notes, and the notes of groups where your role can both edit and delete notes. " +
  "A note you moved to the trash from a group where your role can delete but not edit isn't listed. " +
  `Newest first by when it was moved to the trash; only the newest ${MCP_PAGE_MAX} are returned and there is no paging — ` +
  "`truncated` is true when older ones were left out. " +
  "Notes in the trash don't appear in list_notes or search_notes, and reading or editing one answers not_found. " +
  "`purgeAt` is when a note becomes due to be deleted permanently under the site's current trash setting " +
  "(an admin can change it, which moves every note's date), or null when this site doesn't empty the trash on its own at the moment.";

/** 註冊為 `z.object({}).strict()`（裸 ZodObject，`inputSchema.properties` 是 `{}`）。 */
export const listTrashInput = {};

export const trashItemForModelSchema = z.object({
  id: z.string(),
  title: z.string().max(MCP_TEXT_MAX),
  titleTruncated: z.literal(true).optional(),
  deletedAt: z.string(),
  purgeAt: z.string().nullable(),
  deletedBy: z
    .object({ handle: z.string(), displayName: z.string().max(MCP_TEXT_MAX), displayNameTruncated: z.literal(true).optional() })
    .nullable(),
  group: z.object({ id: z.string(), name: z.string().max(MCP_TEXT_MAX), nameTruncated: z.literal(true).optional() }).nullable(),
});
type TrashItemForModel = z.infer<typeof trashItemForModelSchema>;

export const listTrashOutput = {
  retentionDays: z
    .number()
    .int()
    .nullable()
    .describe(
      "How many days a note stays in the trash before it becomes due to be deleted permanently, under the site's current trash " +
        "setting (an admin can change it); null when this site doesn't empty the trash on its own at the moment."
    ),
  items: z
    .array(trashItemForModelSchema)
    .describe(
      "The notes in your trash, newest first. `deletedBy` is null when the account that moved it there no longer exists; " +
        "`group` is null for a personal note."
    ),
  truncated: z
    .boolean()
    .describe(`True when older ones were left out: only the newest ${MCP_PAGE_MAX} notes in your trash are returned.`),
};

function toTrashItemForModel(item: TrashItemDto): TrashItemForModel {
  const title = truncateText(item.title);
  let deletedBy: TrashItemForModel["deletedBy"] = null;
  if (item.deletedBy !== null) {
    const name = truncateText(item.deletedBy.displayName);
    deletedBy = { handle: item.deletedBy.handle, displayName: name.text, ...(name.truncated ? { displayNameTruncated: true as const } : {}) };
  }
  let group: TrashItemForModel["group"] = null;
  if (item.group !== null) {
    const name = truncateText(item.group.name);
    group = { id: item.group.id, name: name.text, ...(name.truncated ? { nameTruncated: true as const } : {}) };
  }
  return {
    id: item.id,
    title: title.text,
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    deletedAt: item.deletedAt,
    purgeAt: item.purgeAt,
    deletedBy,
    group,
  };
}

export async function listTrash(_args: Record<string, never>, ctx: McpToolCtx): Promise<CallToolResult> {
  const settings = await readTrashRetentionDays(ctx.db);
  // 列不在是部署壞掉：丟給 runTool 收成 internal（訊息只進 log，不進模型脈絡）。
  if (settings === undefined) throw new Error(SITE_SETTINGS_MISSING_MESSAGE);
  const list = await queryTrash(ctx.db, ctx.userId, settings.retentionDays, { limit: MCP_PAGE_MAX });
  return toolResult({ retentionDays: list.retentionDays, items: list.items.map(toTrashItemForModel), truncated: list.truncated });
}
