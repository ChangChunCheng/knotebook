import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOLDER_DEPTH_MAX, FOLDER_NAME_MAX, FOLDERS_PER_SPACE_MAX, type FolderSpaceDto } from "@knotebook/shared";
import { normalizeFolderName } from "../../folders/names.js";
import { createFolder } from "../../folders/service.js";
import { GROUP_ID } from "../../notes/schemas.js";
import { FOLDER_ID, folderForModelSchema } from "../folder-fields.js";
import { FOLDER_POSITION_AMBIGUOUS_MESSAGE, folderFailureToToolError, folderNameErrorMessage } from "../folder-messages.js";
import { folderReply, folderServiceDeps } from "../folder-service.js";
import { toolError } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const CREATE_FOLDER_DESCRIPTION =
  "Create a folder: inside one you can see with `parent_id`, at the top level of one of your groups with `group_id`, " +
  "at the top level of your folders for notes others shared with you with `shared: true`, or at the top level of your personal folders " +
  "when you pass none of them. In a group, it needs a role that can edit notes. " +
  `A name is 1 to ${FOLDER_NAME_MAX} characters with no line breaks or other control characters, and can't repeat the name of a folder ` +
  "already in the same place (names that differ only in letter case can count as the same). " +
  `New folders go at most ${FOLDER_DEPTH_MAX} levels deep, and creating stops at ${FOLDERS_PER_SPACE_MAX} folders in one space. ` +
  "The reply is the new folder, in the shape list_folders returns.";

export const CF_NAME = `The folder's name: 1 to ${FOLDER_NAME_MAX} characters, with no line breaks or other control characters.`;
export const CF_PARENT = "The id of a folder you can see to create this one inside, from list_folders.";
export const CF_GROUP =
  "The id of one of your groups, to create the folder at the top level of its folders. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";
export const CF_SHARED = "True to create the folder at the top level of your folders for notes others shared with you, which only you can see.";
export const FOLDER_REPLY_DESCRIBE = "The folder, in the same shape list_folders returns.";

/** The 1000 on `name` only bounds input; the real limit is the service's. */
export const createFolderInput = {
  name: z.string().max(1000).describe(CF_NAME),
  parent_id: FOLDER_ID.optional().describe(CF_PARENT),
  group_id: GROUP_ID.optional().describe(CF_GROUP),
  shared: z.boolean().optional().describe(CF_SHARED),
};

export const folderReplyOutput = { folder: folderForModelSchema.describe(FOLDER_REPLY_DESCRIBE) };

export interface CreateFolderArgs {
  name: string;
  parent_id?: string;
  group_id?: string;
  shared?: boolean;
}

export async function createFolderTool(args: CreateFolderArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  const name = normalizeFolderName(args.name);
  if (!name.ok) return toolError("invalid_body", folderNameErrorMessage(name.reason));
  const given = [args.parent_id !== undefined, args.group_id !== undefined, args.shared === true].filter(Boolean).length;
  if (given > 1) return toolError("invalid_body", FOLDER_POSITION_AMBIGUOUS_MESSAGE);
  let parent: { folderId: string } | { space: FolderSpaceDto };
  if (args.parent_id !== undefined) parent = { folderId: args.parent_id };
  else if (args.group_id !== undefined) parent = { space: { kind: "group", groupId: args.group_id.toLowerCase() } }; // GROUP_ID doesn't lowercase, so do it here
  else parent = { space: { kind: args.shared === true ? "shared" : "personal" } };

  const out = await createFolder(folderServiceDeps(ctx), { by: ctx.userId, name: args.name, parent });
  if (out.kind === "error") return folderFailureToToolError("create_folder", out);
  return folderReply(ctx, out.folder.id);
}
