import { eq } from "drizzle-orm";
import { notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";
import type { SlugScope } from "../notes/slug.js";
import type { NoteSummaryRow } from "./dto.js";
import type { McpToolCtx } from "./context.js";

/** Pass `owner` by scope: never fill `ctx.userHandle` for a group note (it would become `/n/<me>/<slug>`). `editorHandle` is null because only the re-read-miss race reaches here. */
export function insertedRow(
  row: typeof notes.$inferSelect,
  owner: { ownerHandle: string | null; groupName: string | null }
): NoteSummaryRow {
  return {
    id: row.id,
    title: row.title,
    ownerHandle: owner.ownerHandle,
    groupId: row.groupId,
    groupName: owner.groupName,
    slug: row.slug,
    updatedAt: row.updatedAt,
    lastEditedAt: row.lastEditedAt,
    lastEditedAgentLabel: row.lastEditedAgentLabel,
    editorHandle: null,
    // The creator is the owner or a group member, so their view is the row's own folder.
    viewerFolderId: row.folderId,
  };
}

/**
 * Re-reads for a fresh attribution: insert's `returning()` runs before the merge, so its four
 * `lastEdited` fields are still null. A miss means the note was deleted or the caller removed
 * from the group meanwhile; the content is already written, so the caller falls back to the
 * insert row (a stale `lastEdited` beats an AI retry creating a second note). The select
 * builders are single-use, so build the branch fresh each call. The grouped branch requires
 * `can_read`: the creator has `can_create`, which implies `can_read` (`group_roles_read_implied_chk`).
 */
export async function rereadVisibleNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string,
  scope: SlugScope
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const branches = visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) });
  const [row] = await ("groupId" in scope ? branches.grouped : branches.owned);
  return row;
}

/** A miss means the note was moved, purged or demoted after the restore commit. */
export async function rereadOwnOrGroupNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const [owned] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).owned;
  if (owned) return owned;
  const [grouped] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).grouped;
  return grouped;
}

/** A shared note is only visible through the shared branch; the three branches are mutually exclusive. */
export async function rereadAnyVisibleNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const [owned] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).owned;
  if (owned) return owned;
  const [shared] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).shared;
  if (shared) return shared;
  const [grouped] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).grouped;
  return grouped;
}
