/** Keyset = millisecond `deleted_at` DESC, id DESC (same as REST); at most `MCP_PAGE_MAX` per page, fewer when cut by the wire budget (`pageCutShort`). The output is an object so it can only grow: `truncated` keeps its name and means "there is a next page". `deletedAt:`/`deletedBy:` here are read mappings, registered in `trash-structure.test.ts`. */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TrashItemDto } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../../auth/tx/admin-site-settings.js";
import { UUID_RE } from "../../notes/service.js";
import { listTrashPage, readTrashRetentionDays, type TrashCursor } from "../../trash/list.js";
import { truncateFolderPath } from "../folder-fields.js";
import { BAD_CURSOR_MESSAGE, decodeKeysetCursor, encodeKeysetCursor, parseCursorTimestamp } from "../keyset-cursor.js";
import { MCP_FOLDER_NAME_MAX, MCP_PAGE_MAX, MCP_TEXT_MAX, truncateText } from "../limits.js";
import { NEXT_CURSOR_DESCRIBE, PAGE_CUT_SHORT_DESCRIBE } from "../paging-strings.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

export const LIST_TRASH_DESCRIPTION =
  "List the notes in your trash: your own personal notes, and the notes of groups where your role can both edit and delete notes. " +
  "A note you moved to the trash from a group where your role can delete but not edit isn't listed. " +
  `Newest first by when it was moved to the trash, up to ${MCP_PAGE_MAX} per call and fewer when they are large; ` +
  "pass `nextCursor` back as `cursor` for the next page, until it is null. " +
  "Paging reads live data, not a snapshot: a note moved to the trash while you page lands above your cursor. " +
  "`folderPath` is where the note usually goes back to when restored: the folder names from the top level down, or empty for the top level. " +
  "While the note's folder still exists, the path follows renames and moves of the folders on it; " +
  "once that folder is deleted, the path no longer follows renames. A long path is cut from the top, with `folderPathTruncated`. " +
  "Notes in the trash don't appear in list_notes or search_notes, and reading or editing one answers not_found. " +
  "`purgeAt` is when a note becomes due to be deleted permanently under the site's current trash setting " +
  "(an admin can change it, which moves every note's date), or null when this site doesn't empty the trash on its own at the moment.";

export const LT_CURSOR_DESCRIBE = "Opaque cursor from a previous call's `nextCursor`. Omit it to start with the newest.";
export const LT_TRUNCATED_DESCRIBE = "True when more notes follow this page — the same as `nextCursor` not being null.";

export const listTrashInput = {
  cursor: z.string().min(1).max(200).optional().describe(LT_CURSOR_DESCRIBE),
};

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
  folderPath: z.array(z.string().max(MCP_FOLDER_NAME_MAX)),
  folderPathTruncated: z.literal(true).optional(),
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
  truncated: z.boolean().describe(LT_TRUNCATED_DESCRIBE),
  nextCursor: z.string().nullable().describe(NEXT_CURSOR_DESCRIBE),
  pageCutShort: z.literal(true).optional().describe(PAGE_CUT_SHORT_DESCRIBE),
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
  const path = truncateFolderPath(item.folderPath);
  return {
    id: item.id,
    title: title.text,
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    deletedAt: item.deletedAt,
    purgeAt: item.purgeAt,
    deletedBy,
    group,
    folderPath: path.path,
    ...(path.truncated ? { folderPathTruncated: true as const } : {}),
  };
}

/** The time is the sort key (`deletedAtMs`), not the DTO's `deletedAt` (same reason as list_notes). */
function encodeTrashCursor(key: TrashCursor): string {
  return encodeKeysetCursor("t", [key.deletedAtMs.toISOString(), key.id]);
}

function decodeTrashCursor(raw: string): TrashCursor | null {
  const parts = decodeKeysetCursor(raw, "t", 2);
  if (parts === null) return null;
  const [ts, id] = parts as [string, string];
  if (!UUID_RE.test(id)) return null;
  const at = parseCursorTimestamp(ts);
  if (at === null) return null;
  return { deletedAtMs: at, id };
}

const TRASH_CURSOR_PLACEHOLDER = encodeTrashCursor({ deletedAtMs: new Date("2026-01-01T00:00:00.000Z"), id: "00000000-0000-0000-0000-000000000000" });
export const TRASH_BASE_COST =
  wireCost({ retentionDays: 3650, items: [], truncated: true, nextCursor: TRASH_CURSOR_PLACEHOLDER }) + PAGE_CUT_RESERVE;

export async function listTrash(args: { cursor?: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  let after: TrashCursor | null = null;
  if (args.cursor !== undefined) {
    after = decodeTrashCursor(args.cursor);
    if (after === null) return toolError("invalid_body", BAD_CURSOR_MESSAGE);
  }
  const settings = await readTrashRetentionDays(ctx.db);
  // A missing row is a broken deployment; the message goes to the log only.
  if (settings === undefined) throw new Error(SITE_SETTINGS_MISSING_MESSAGE);
  const page = await listTrashPage(ctx.db, ctx.userId, settings.retentionDays, { limit: MCP_PAGE_MAX, after });
  const items = page.items.map(toTrashItemForModel);
  const kept = countWithinWireBudget(items.map(wireCost), TRASH_BASE_COST);
  const cut = kept < items.length;
  const lastKey = cut ? page.keys[kept - 1] : page.hasMore ? page.keys[page.keys.length - 1] : undefined;
  const nextCursor = lastKey === undefined ? null : encodeTrashCursor(lastKey);
  return toolResult({
    retentionDays: settings.retentionDays,
    items: cut ? items.slice(0, kept) : items,
    truncated: nextCursor !== null,
    nextCursor,
    ...(cut ? { pageCutShort: true as const } : {}),
  });
}
