/**
 * Keyset paging is not a snapshot. `updated_at` changes only on insert and on title/slug
 * PATCH (nothing in `notes/editing/` writes it), so rows can be missed when a row moves from
 * below the cursor to above it. The opposite also happens: a note shared with you, a group
 * you join, or a note moved into your group (`notes/tx/move.ts`, which doesn't write
 * `updatedAt`) joins the visible set (recomputed per page) with its unchanged `updated_at`,
 * and if that falls in a section already paged past, no page shows it. The model can't
 * detect this, so `LIST_NOTES_DESCRIPTION` says so verbatim (pinned in `mcp-notes.test.ts`;
 * don't delete). `hasMore` comes from `.limit(limit + 1)`, never a second query.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UUID_RE } from "../../notes/service.js";
import { noNul } from "../../notes/schemas.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { BAD_CURSOR_MESSAGE, BASE64URL_RE, parseCursorTimestamp } from "../keyset-cursor.js";
import { MCP_PAGE_MAX } from "../limits.js";
import { NEXT_CURSOR_DESCRIBE, PAGE_CUT_SHORT_DESCRIBE } from "../paging-strings.js";
import { buildNoteListQuery, type NoteListCursor } from "../queries.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 50;
const CURSOR_SEP = "|";

export const LIST_NOTES_DESCRIPTION =
  "List the notes you can see — the ones you own, the notes of your groups, and the ones shared with you — " +
  "most recently updated first. Each result carries `owner` (a person or one of your groups) and `role` so you can " +
  "tell whose content you are reading. Paging reads live data, not a snapshot: creating a note, or renaming it, moves " +
  "it to the top of this order, above the cursor you are holding, so no later page shows it. Editing a note's content " +
  "does not move it. While you page, a note shared with you, a note moved into one of your groups, or the notes of a " +
  "group you join appear at their own unchanged positions, which may already be above your cursor. " +
  "A page can hold fewer notes than `limit` when the notes are large — `pageCutShort` is then true — so keep paging until `nextCursor` is null.";

export const listNotesInput = {
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Opaque cursor from a previous call's `nextCursor`. Omit it to start at the first page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_PAGE_MAX)
    .optional()
    .describe(`How many notes to return, 1 to ${MCP_PAGE_MAX}. Defaults to ${DEFAULT_LIMIT}.`),
};

export const listNotesOutput = {
  notes: z.array(noteSummarySchema).describe("The page of notes, most recently updated first."),
  nextCursor: z.string().nullable().describe(NEXT_CURSOR_DESCRIBE),
  pageCutShort: z.literal(true).optional().describe(PAGE_CUT_SHORT_DESCRIBE),
};

export interface ListNotesArgs {
  cursor?: string;
  limit?: number;
}

/** The timestamp is `updatedAtMs` (the sort key), not `updatedAt`: a cursor of different precision silently drops rows (see `mcp/queries.ts`). The two are equal in JS only because node-postgres truncates timestamptz to milliseconds (an implementation detail, don't rely on it). */
function encodeCursor(row: { updatedAtMs: Date; id: string }): string {
  return Buffer.from(`${row.updatedAtMs.toISOString()}${CURSOR_SEP}${row.id}`, "utf8").toString("base64url");
}

const CURSOR_PLACEHOLDER = encodeCursor({ updatedAtMs: new Date("2026-01-01T00:00:00.000Z"), id: "00000000-0000-0000-0000-000000000000" });
export const LIST_BASE_COST = wireCost({ notes: [], nextCursor: CURSOR_PLACEHOLDER }) + PAGE_CUT_RESERVE;

/**
 * Format checks are needed because base64url decoding yields garbage instead of throwing,
 * and garbage reaching the keyset predicate would make pg error → `internal` instead of "bad
 * cursor". The time goes through `parseCursorTimestamp` (a bare `new Date(ts)` accepts forms
 * pg rejects). `noNul` also covers positions other than the id field. The charset is checked
 * first because `Buffer.from(…, "base64url")` skips characters outside it.
 */
function decodeCursor(raw: string): NoteListCursor | null {
  if (!BASE64URL_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!noNul(decoded)) return null;
  const parts = decoded.split(CURSOR_SEP);
  if (parts.length !== 2) return null;
  const [ts, id] = parts as [string, string];
  if (!UUID_RE.test(id)) return null;
  const updatedAt = parseCursorTimestamp(ts);
  if (updatedAt === null) return null;
  return { updatedAt, id };
}

export async function listNotes(args: ListNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  let cursor: NoteListCursor | null = null;
  if (args.cursor !== undefined) {
    cursor = decodeCursor(args.cursor);
    if (cursor === null) {
      return toolError("invalid_body", BAD_CURSOR_MESSAGE);
    }
  }

  const rows = await buildNoteListQuery(ctx.db, { userId: ctx.userId, cursor, limit });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const summaries = await noteSummariesForModel(ctx.db, page);
  // The cursor points at the last kept note (`updatedAtMs`, as in encodeCursor).
  const kept = countWithinWireBudget(summaries.map(wireCost), LIST_BASE_COST);
  if (kept < page.length) {
    return toolResult({ notes: summaries.slice(0, kept), nextCursor: encodeCursor(page[kept - 1]!), pageCutShort: true });
  }
  const last = page[page.length - 1];
  return toolResult({
    notes: summaries,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  });
}
