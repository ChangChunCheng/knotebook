/**
 * A `.transaction(` callback here must be one `xInTx(tx, …)` call (`test/unit/s14-structure.test.ts`).
 * Callers pass ids already lowercased (routes, MCP `FOLDER_ID`); only the UUID shape is checked here, and the transactions compare ids with plain `===`.
 */
import { and, asc, isNull, sql } from "drizzle-orm";
import type { ErrorCode, FolderDeleteResultDto, FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import type { CollabHooks, NoteDeleteGate } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { foreignKeyViolationConstraint, isFolderSpaceViolation, isRetryableTxError, uniqueViolationConstraint } from "../db/pg-errors.js";
import { GROUP_NOT_FOUND_MESSAGE } from "../groups/queries.js";
import type { GroupHookCtx, GroupTestHook } from "../groups/test-hook.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { loadNoteFields, toNoteDto } from "../notes/note-dto.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";
import {
  FOLDER_CROSS_SPACE_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE,
  FOLDER_NOT_EMPTY_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PLACE_FORBIDDEN_MESSAGE,
} from "./messages.js";
import { normalizeFolderName, type FolderNameResult } from "./names.js";
import { folderPermissions } from "./permissions.js";
import { listVisibleFolders, resolveFolderAccess, toFolderDto } from "./queries.js";
import { sameFolderSpace, type FolderSpace } from "./space.js";
import { subtreeFolderIdsSql } from "./sql.js";
import { createFolderInTx, type CreateFolderInput } from "./tx/create-folder.js";
import { deleteFolderInTx, type DeleteFolderInput } from "./tx/delete-folder.js";
import { placeNoteInTx, placeTargetSpace, type PlaceMode, type PlaceNoteInput } from "./tx/place-note.js";
import { updateFolderInTx, type UpdateFolderInput } from "./tx/update-folder.js";

const NAME_MESSAGES: Record<Extract<FolderNameResult, { ok: false }>["reason"], string> = {
  unstorable: "The folder name contains characters that can't be stored.",
  control: "The folder name can't contain line breaks or control characters.",
  length: "Folder names must be 1 to 80 characters.",
};
const FOLDER_NAME_TAKEN_MESSAGE = "A folder with that name already exists here.";
const TOO_MANY_REQUESTS_MESSAGE = "Too many writes. Wait a moment and try again.";
const SERVER_BUSY_MESSAGE = "The server is busy. Try again in a moment.";

export interface FolderServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
  limiters: { folder: FixedWindowLimiter };
}

export interface FolderFailure { kind: "error"; status: 400 | 403 | 404 | 409 | 429; code: ErrorCode; message: string }

const fail = (status: FolderFailure["status"], code: ErrorCode, message: string): FolderFailure => ({ kind: "error", status, code, message });

export async function listFolders(db: Db, userId: string): Promise<FolderDto[]> {
  return listVisibleFolders(db, userId);
}

export async function createFolder(
  deps: FolderServiceDeps,
  input: { by: string; name: string; parent: { folderId: string } | { space: FolderSpaceDto } },
): Promise<{ kind: "ok"; folder: FolderDto } | FolderFailure> {
  const name = normalizeFolderName(input.name);
  if (!name.ok) return fail(400, "invalid_body", NAME_MESSAGES[name.reason]);

  let target: CreateFolderInput["target"];
  let hookCtx: GroupHookCtx;
  if ("folderId" in input.parent) {
    const folderId = input.parent.folderId;
    const access = await resolveFolderAccess(deps.db, input.by, folderId);
    if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
    target = { kind: "parent", folderId, space: access.space };
    hookCtx = { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) };
  } else {
    const requested = input.parent.space;
    let space: FolderSpace;
    if (requested.kind === "group") {
      // Non-UUID, nonexistent, non-member and no-read-flag all get the same 404, so group existence doesn't leak.
      if (!UUID_RE.test(requested.groupId)) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      space = { kind: "group", groupId: requested.groupId };
      const m = await loadCreateTarget(deps.db, input.by, requested.groupId);
      const perms = m === undefined ? null : folderPermissions(space, input.by, m);
      if (perms === null) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      if (!perms.manage) return fail(403, "forbidden", FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE);
    } else {
      space = { kind: requested.kind, ownerId: input.by };
    }
    target = { kind: "root", space };
    hookCtx = space.kind === "group" ? { groupId: space.groupId } : {};
  }

  if (!deps.limiters.folder.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  await deps.groupTestHook?.("folder-authorized", hookCtx);

  const txInput: CreateFolderInput = { by: input.by, name: name.name, lockTimeoutMs: deps.storageLockTimeoutMs, target };
  let out: Awaited<ReturnType<typeof createFolderInTx>>;
  try {
    out = await deps.db.transaction(tx => createFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (uniqueViolationConstraint(err) === "folders_sibling_name_idx") return fail(409, "folder_name_taken", FOLDER_NAME_TAKEN_MESSAGE);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    // Defence in depth: the trigger only fires if the space changed after the pre-read; reported as invisible.
    if (isFolderSpaceViolation(err)) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    throw err;
  }
  return { kind: "ok", folder: toFolderDto(out.row, out.permissions) };
}

export async function updateFolder(
  deps: FolderServiceDeps,
  input: { by: string; folderId: string; name?: string; parentId?: string | null },
): Promise<{ kind: "ok"; folder: FolderDto } | FolderFailure> {
  let name: string | undefined;
  if (input.name !== undefined) {
    const normalized = normalizeFolderName(input.name);
    if (!normalized.ok) return fail(400, "invalid_body", NAME_MESSAGES[normalized.reason]);
    name = normalized.name;
  }

  const access = await resolveFolderAccess(deps.db, input.by, input.folderId);
  if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);

  let parentId: string | null | undefined = input.parentId;
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = await resolveFolderAccess(deps.db, input.by, input.parentId);
    if (parent === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!sameFolderSpace(parent.space, access.space)) return fail(400, "folder_cross_space", FOLDER_CROSS_SPACE_MESSAGE);
    parentId = parent.folder.id;
  }
  if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);

  if (!deps.limiters.folder.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  const folderId = access.folder.id;
  await deps.groupTestHook?.("folder-authorized", { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) });

  const txInput: UpdateFolderInput = {
    by: input.by,
    folderId,
    space: access.space,
    ...(name !== undefined ? { name } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    lockTimeoutMs: deps.storageLockTimeoutMs,
  };
  let out: Awaited<ReturnType<typeof updateFolderInTx>>;
  try {
    out = await deps.db.transaction(tx => updateFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (uniqueViolationConstraint(err) === "folders_sibling_name_idx") return fail(409, "folder_name_taken", FOLDER_NAME_TAKEN_MESSAGE);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    // Defence in depth: same-space is already checked in the transaction; KF002 only fires if the space changed after the pre-read; reported as invisible.
    if (isFolderSpaceViolation(err)) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    throw err;
  }
  return { kind: "ok", folder: toFolderDto(out.row, out.permissions) };
}

/**
 * Gates are released on success and failure: a gate left open for a note that moved out after the pre-read would block new connections until its TTL (`releaseDeletingGate` only reclaims live notes).
 * Shared folders skip the pre-read and gates: their notes aren't touched (placements CASCADE).
 * `onlyIfEmpty`: live notes in the pre-read → 409 `folder_not_empty`, before `folder_delete_blocked`, without charging the limiter or opening gates;
 * subfolders and placements are judged only in the transaction (authoritative).
 */
export async function deleteFolder(
  deps: FolderServiceDeps,
  input: { by: string; folderId: string; onlyIfEmpty?: boolean },
): Promise<{ kind: "ok"; result: FolderDeleteResultDto } | FolderFailure> {
  const access = await resolveFolderAccess(deps.db, input.by, input.folderId);
  if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  const folderId = access.folder.id;
  const onlyIfEmpty = input.onlyIfEmpty === true;

  let liveIds: string[] = [];
  if (access.space.kind !== "shared") {
    const rows = await deps.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(sql`${notes.folderId} in (${subtreeFolderIdsSql(folderId)})`, isNull(notes.deletedAt)))
      .orderBy(asc(notes.id));
    liveIds = rows.map(r => r.id);
    if (onlyIfEmpty && liveIds.length > 0) return fail(409, "folder_not_empty", FOLDER_NOT_EMPTY_MESSAGE);
    if (liveIds.length > 0 && !access.permissions.deleteNotes) return fail(403, "folder_delete_blocked", FOLDER_DELETE_BLOCKED_MESSAGE);
  }

  if (!deps.limiters.folder.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  const hookCtx: GroupHookCtx = { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) };
  await deps.groupTestHook?.("folder-authorized", hookCtx);

  // allSettled: gates shouldn't throw, but if one rejects, release the already-opened ones, then rethrow.
  const settled = await Promise.allSettled(liveIds.map(id => deps.collabHooks.beforeNoteDeleted(id)));
  const gates: NoteDeleteGate[] = settled.flatMap(s => (s.status === "fulfilled" ? [s.value] : []));
  const releaseAll = (): void => {
    for (const g of gates) g.release();
  };
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejected) {
    releaseAll();
    throw rejected.reason;
  }

  const txInput: DeleteFolderInput = {
    by: input.by, folderId, space: access.space, gatedNoteIds: liveIds, lockTimeoutMs: deps.storageLockTimeoutMs, onlyIfEmpty,
  };
  let result: FolderDeleteResultDto;
  try {
    // Inside the try so a throwing hook still reaches the finally's releaseAll.
    await deps.groupTestHook?.("folder-delete-gated", hookCtx);
    result = await deps.db.transaction(tx => deleteFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    throw err;
  } finally {
    releaseAll();
  }
  return { kind: "ok", result };
}

export async function placeNote(
  deps: FolderServiceDeps,
  input: { by: string; noteId: string; folderId: string | null },
): Promise<{ kind: "ok"; note: NoteDto } | FolderFailure> {
  const { by } = input;
  const noteAccess = await resolveNoteAccess(deps.db, by, input.noteId);
  if (noteAccess.role === "none") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  let mode: PlaceMode;
  if (noteAccess.role === "owner") mode = { kind: "owned" };
  else if (noteAccess.groupId !== null) {
    if (!noteAccess.permissions.edit) return fail(403, "forbidden", NOTE_PLACE_FORBIDDEN_MESSAGE);
    mode = { kind: "group", groupId: noteAccess.groupId };
  } else mode = { kind: "shared" };
  const noteId = input.noteId.toLowerCase();

  let folderId: string | null = null;
  if (input.folderId !== null) {
    const folder = await resolveFolderAccess(deps.db, by, input.folderId);
    if (folder === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!sameFolderSpace(folder.space, placeTargetSpace(mode, by))) return fail(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
    folderId = folder.folder.id;
  }

  if (!deps.limiters.folder.consume(by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  await deps.groupTestHook?.("note-folder-authorized", { noteId, ...(folderId !== null ? { folderId } : {}) });

  const txInput: PlaceNoteInput = { by, noteId, folderId, mode };
  try {
    await deps.db.transaction(tx => placeNoteInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    // Share revoked after the recheck but before the upsert (revoking doesn't lock notes): reported as not visible.
    const fk = foreignKeyViolationConstraint(err);
    if (fk === "note_placements_share_fk") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
    // Defence in depth: the folder was locked and its space checked in the transaction; these only come from drift outside that.
    if (fk === "notes_folder_fk" || fk === "note_placements_folder_id_folders_id_fk" || isFolderSpaceViolation(err)) {
      return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    }
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    throw err;
  }

  // Narrow race: moved or demoted between commit and re-read: reported as not visible.
  const fields = await loadNoteFields(deps.db, noteId, by);
  const access = await resolveNoteAccess(deps.db, by, noteId);
  if (fields === undefined || access.role === "none") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  return { kind: "ok", note: toNoteDto(fields, access) };
}
