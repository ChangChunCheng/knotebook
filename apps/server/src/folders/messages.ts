/**
 * Error messages shared by the folder transactions and the service layer, so the fast path outside the
 * transaction and the in-transaction checks return byte-identical 404/403/409 bodies.
 */
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";

export const FOLDER_NOT_FOUND_MESSAGE = "No folder with that id.";
export const FOLDER_FORBIDDEN_MESSAGE = "You don't have permission to manage this folder.";
/** Group root (addressed by group id, no concrete folder): roles that can't edit are refused. Same wording as `POST /api/notes {groupId}`. */
export const FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE = "Your role in this group can't create folders.";
export const FOLDER_TOO_DEEP_MESSAGE = `Folders can be nested at most ${FOLDER_DEPTH_MAX} levels deep.`;
export const FOLDER_LIMIT_MESSAGE = "This space has reached its folder limit.";
/** Move: both folders are visible but live in different spaces. */
export const FOLDER_CROSS_SPACE_MESSAGE = "A folder can't be moved to another space.";
export const FOLDER_CYCLE_MESSAGE = "A folder can't be moved into itself or one of its subfolders.";
/** Delete: the subtree has live notes and the caller lacks delete permission (same text outside and inside the transaction). */
export const FOLDER_DELETE_BLOCKED_MESSAGE = "The folder contains notes you can't delete.";
/** Delete: live notes in the subtree without an opened gate, or `trashNotesInTx` reported notes no longer reachable (role changed after the recheck). */
export const FOLDER_CONTENT_CHANGED_MESSAGE = "The folder's contents just changed. Try again.";
/** `onlyIfEmpty`: the folder has subfolders, live notes or placements (same text outside and inside the transaction). */
export const FOLDER_NOT_EMPTY_MESSAGE = "The folder isn't empty, so it wasn't deleted.";
/** Place: note missing, invisible, trashed, or unshared mid-placement (23503). Same text as the note routes' 404. */
export const NOTE_NOT_FOUND_MESSAGE = "No note with that id.";
export const NOTE_PLACE_FORBIDDEN_MESSAGE = "You don't have permission to organize this note.";
export const NOTE_FOLDER_CROSS_SPACE_MESSAGE = "A note can't go into a folder in another space.";
/** Shared by create, copy and move-into-group. */
export const NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE = "Your role in this group can't put notes in folders.";
