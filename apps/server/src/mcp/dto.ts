/**
 * A subset of REST `NoteDto` (a published contract, so trimming happens only here), with REST's
 * `ownerHandle`/`groupId`/`group` collapsed into `owner`. `url` must come from
 * `canonicalNotePath`: a hand-built URL that is wrong is a silent dead link.
 */
import { z } from "zod";
import { canonicalNotePath } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { folderRefForModel, folderRefSchema, loadFolderNames, type FolderRefForModel } from "./folder-fields.js";
import { MCP_TEXT_MAX, truncateText } from "./limits.js";

/** Doesn't mention read_note_outline: it only exists with collab, and this schema is shared by all deployments. */
export const NS_FOLDER_DESCRIBE =
  "Where this note is filed for you, or null at the top level; for a note shared with you, where you filed it, not where its owner did. Only the folder itself — list_folders gives its path.";

/**
 * A tagged object rather than a nullable `ownerHandle`, which would suggest a group note has
 * no owner. The group `name` is truncated like `title`; DB max is 80 code points, so only
 * names full of escape-costly characters (C0 costs 6) hit it, then `nameTruncated: true`.
 */
export type NoteOwnerForModel =
  | { kind: "user"; handle: string }
  | { kind: "group"; id: string; name: string; nameTruncated?: true };

export const noteOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), handle: z.string() }),
  z.object({
    kind: z.literal("group"),
    id: z.string(),
    name: z.string().max(MCP_TEXT_MAX),
    nameTruncated: z.literal(true).optional(),
  }),
]);

/** Both empty is impossible (`notes_owner_xor_group_chk`): throw rather than guess. */
export function ownerForModel(row: { ownerHandle: string | null; groupId: string | null; groupName: string | null }): NoteOwnerForModel {
  if (row.groupId !== null) {
    const name = truncateText(row.groupName ?? "");
    return { kind: "group", id: row.groupId, name: name.text, ...(name.truncated ? { nameTruncated: true as const } : {}) };
  }
  if (row.ownerHandle !== null) return { kind: "user", handle: row.ownerHandle };
  throw new Error("ownerForModel：ownerHandle 與 groupId 皆為 null");
}

export interface NoteSummaryForModel {
  id: string;
  title: string;
  /**
   * Only present (as `true`) when truncated. `z.literal(true)` catches `false`; `undefined`
   * is invisible on the wire (JSON.stringify drops it), so the conditional spread is discipline; `exactOptionalPropertyTypes` is off, so types don't catch it either.
   */
  titleTruncated?: true;
  owner: NoteOwnerForModel;
  slug: string;
  url: string;
  role: string;
  updatedAt: string;
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
  /** For a shared note this is the caller's own placement, not the owner's. */
  folder: FolderRefForModel | null;
}

export const noteSummarySchema = z.object({
  id: z.string(),
  title: z.string().max(MCP_TEXT_MAX),
  titleTruncated: z.literal(true).optional(),
  owner: noteOwnerSchema,
  slug: z.string(),
  url: z.string(),
  role: z.string(),
  updatedAt: z.string(),
  lastEdited: z
    .object({ at: z.string(), byHandle: z.string(), agentLabel: z.string().nullable() })
    .nullable(),
  folder: folderRefSchema.nullable().describe(NS_FOLDER_DESCRIBE),
});

export interface NoteSummaryRow {
  id: string;
  title: string;
  ownerHandle: string | null;
  groupId: string | null;
  groupName: string | null;
  slug: string;
  updatedAt: Date;
  lastEditedAt: Date | null;
  lastEditedAgentLabel: string | null;
  editorHandle: string | null;
  viewerFolderId: string | null;
}

/** `folderName` is undefined when the folder was deleted between statements → `folder: null`. */
export function toNoteSummary(row: NoteSummaryRow, role: string, folderName: string | undefined): NoteSummaryForModel {
  const title = truncateText(row.title);
  return {
    id: row.id,
    title: title.text,
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    owner: ownerForModel(row),
    slug: row.slug,
    url: canonicalNotePath({ ownerHandle: row.ownerHandle, groupId: row.groupId, slug: row.slug }),
    role,
    updatedAt: row.updatedAt.toISOString(),
    // last_edited_by is FK `set null`: a deleted editor gives handle "".
    lastEdited: row.lastEditedAt
      ? { at: row.lastEditedAt.toISOString(), byHandle: row.editorHandle ?? "", agentLabel: row.lastEditedAgentLabel }
      : null,
    folder: row.viewerFolderId !== null && folderName !== undefined ? folderRefForModel(row.viewerFolderId, folderName) : null,
  };
}

/** Names are looked up separately so REST lists don't pay for the join. `viewerFolderId` is always visible to the caller (a trigger keeps placements in the placer's own space). */
export async function noteSummariesForModel(
  db: DbOrTx,
  rows: ReadonlyArray<NoteSummaryRow & { role: string }>,
): Promise<NoteSummaryForModel[]> {
  const names = await loadFolderNames(db, rows.map(r => r.viewerFolderId));
  return rows.map(r => toNoteSummary(r, r.role, r.viewerFolderId === null ? undefined : names.get(r.viewerFolderId)));
}
