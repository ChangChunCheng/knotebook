/**
 * Test-injection points for group-related races (like `slugUpdateTestHook`/`noteCreateHooks`); never injected in production, so zero cost.
 * Each point sits in a window between two steps (lock taken but write not yet done, or after authorization but before the row read/write),
 * where integration tests let a second request interleave to make the racy ordering deterministic.
 */
export type GroupRacePoint =
  /** `GET /api/notes/:ref`: after authorization, before the row read. */
  | "ref-authorized"
  /** `POST /api/notes {groupId}` and MCP `create_note {groupId}`: after the membership and `can_create` checks, before the note is created. */
  | "membership-checked"
  /** `PUT /api/notes/:id/shares`: after authorization, before the transaction (window: note moved into a group after authorization). */
  | "share-authorized"
  /** public-link token PUT, alias PUT and width PUT (#297), token DELETE and alias DELETE (#181): after authorization, before UPDATE. */
  | "public-link-authorized"
  /** `PUT /api/notes/:id/shares`: after the `FOR SHARE` read saw `group_id IS NULL`, before the upsert. */
  | "share-group-checked"
  /** `groups/tx/roles.ts`: after `lockGroup` locked the `groups` row and the role passed the built-in checks, before writing `group_roles`/`group_members`. */
  | "group-roles-checked"
  /**
   * `addMemberInTx`/`setMemberRoleInTx`/`removeMemberInTx` (`groups/tx/members.ts`): after `lockGroup` and that function's own checks, before writing `group_members`.
   * The checks differ: `addMemberInTx` only resolves the role (`already_member` is decided by the later INSERT); `setMemberRoleInTx` resolves the new role,
   * confirms membership, and counts admins when a built-in admin is demoted (an unchanged role returns early and skips this point);
   * `removeMemberInTx` confirms membership and counts admins when a built-in admin is removed.
   */
  | "group-members-checked"
  /** `notes/tx/move.ts`: after the note row is locked `FOR UPDATE` and the target group check passed, before per-user shares are deleted. */
  | "note-move-locked"
  /** After each slug probe round, before the savepoint write (ctx.slug = this round's candidate). */
  | "note-move-slug-candidate"
  /** `notes/tx/copy.ts` (group targets only): after the target `groups` row is locked `FOR KEY SHARE` and membership revalidated, before the source is locked. */
  | "note-copy-target-locked"
  /** `notes/tx/copy.ts`: after the source is locked `FOR KEY SHARE` (for a group target the target lock is already held), before attachments are read and the copy created. */
  | "note-copy-locked"
  /**
   * Storage quota: after the attachment files are copied (after the `copyFile` loop), before the space lock and the copy are created
   * (ctx.noteId = the **source**; the copy doesn't exist yet). Tests throw here to simulate a failure.
   */
  | "note-copy-files-copied"
  /** By-path lookups (/n/ and /g/): after the row is fetched, before `authorizeRow` (window: note moved after the fetch). */
  | "path-resolved"
  /** `transferGroupInTx` (`groups/tx/delete-group.ts`): per note, after each slug probe round, before the savepoint write (ctx.noteId, ctx.slug = this round's candidate). */
  | "group-transfer-slug-candidate"
  /** `DELETE /api/groups/:id` delete-all mode (route, **outside** the transaction): after all gates are open, before `BEGIN` (windows: a note enters the group after the gates; another admin's transfer finishes first). */
  | "group-delete-gated"
  /** Group deletion (`groups/tx/delete-group.ts`): transfer = after `lockGroup` and the transferTo check, before members and notes are read; delete-all (`deleteGroupWithNotesInTx`) = after `lockGroup`, before the group's notes are locked. */
  | "group-delete-locked"
  /**
   * Storage quota: after `assertSpaceRoomInTx` took the space advisory lock and `lock_timeout` was restored, before the quota and SUM are read.
   * All four whitelisted transactions pass through it (upload `insertUploadInTx`, move `moveNoteToGroupInTx`, copy `copyNoteInTx`, transfer `transferGroupInTx`);
   * callers supply ctx: upload `{noteId}`, move `{noteId, groupId}`, copy `{noteId: source, groupId?: target group}`, transfer `{groupId: deleted group}`.
   */
  | "storage-space-locked"
  /** `trashNotesInTx` (`notes/tx/trash.ts`, #181): after the notes to trash are locked `FOR UPDATE`, before delete permission is rechecked in the transaction. */
  | "note-trash-locked"
  /** `restoreNotesInTx` (#181): after the note rows are locked `FOR UPDATE`, before classification and the trash-permission recheck. */
  | "note-restore-locked"
  /** `purgeTrashedNotesInTx` (#181): after the note rows are locked `FOR UPDATE`, before classification and the trash-permission recheck. */
  | "note-purge-locked"
  /** `purgeExpiredBatchInTx` (#181): after expired rows are picked with `FOR UPDATE SKIP LOCKED`, before `deleteNotesInTx` (ctx.noteId = first note of the batch; absent for an empty batch). */
  | "trash-purge-locked"
  /** REST move / MCP `move_note_to_group` (`notes/move-note.ts`, #181): after authorization, before `.transaction(`. */
  | "note-move-authorized"
  /** REST copy / MCP `copy_note` (`notes/copy-note.ts`, #181): after authorization, before `.transaction(` (ctx.noteId = source). */
  | "note-copy-authorized"
  /** `POST /api/notes/:id/uploads` (`routes/uploads.ts`, #181): after authorization, before `.transaction(`. */
  | "upload-authorized"
  /** Folder create / rename-move / delete (`folders/service.ts`): after authorization outside the transaction, before the gates / `.transaction(`. */
  | "folder-authorized"
  /** Folder structure lock (`lockFolderSpacesInTx` in `folders/tx/lock.ts`): after all structure-lock keys are taken and `lock_timeout` restored (not fired when there are no keys). */
  | "folder-structure-locked"
  /** Folder delete: after all gates are open, before the transaction. */
  | "folder-delete-gated"
  /** Folder delete (`folders/tx/delete-folder.ts`): after the subtree's notes are locked in one statement, before live and trashed notes are split (also before the `onlyIfEmpty` check). */
  | "folder-delete-notes-locked"
  /** `placeNote`: after authorization outside the transaction, before the transaction. */
  | "note-folder-authorized"
  /** `folders/tx/place-note.ts`: after the note is locked and rechecked in the transaction, before the write. */
  | "note-folder-locked"
  /** `copyNoteInTx` into a folder (`notes/tx/copy.ts`): after the target folder is locked `FOR KEY SHARE` and rechecked, before the source is locked. */
  | "note-copy-folder-locked"
  /** `restoreTrashed` (`trash/service.ts`): after the pre-check and the space pre-read, before the transaction. */
  | "trash-restore-prejudged"
  /** `PUT /api/favorites/:id` (`routes/favorites.ts`, #334): after authorization and limiter consumption, before the write (window: note permanently deleted after authorization). */
  | "favorite-authorized";

export interface GroupHookCtx { noteId?: string; groupId?: string; slug?: string; folderId?: string }

export type GroupTestHook = (point: GroupRacePoint, ctx: GroupHookCtx) => Promise<void>;
