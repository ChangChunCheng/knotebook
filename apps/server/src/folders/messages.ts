/** Shared with the service layer's fast path so both return byte-identical bodies. */
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";

export const FOLDER_NOT_FOUND_MESSAGE = "No folder with that id.";
export const FOLDER_FORBIDDEN_MESSAGE = "You don't have permission to manage this folder.";
export const FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE = "Your role in this group can't create folders.";
export const FOLDER_TOO_DEEP_MESSAGE = `Folders can be nested at most ${FOLDER_DEPTH_MAX} levels deep.`;
export const FOLDER_LIMIT_MESSAGE = "This space has reached its folder limit.";
export const FOLDER_CROSS_SPACE_MESSAGE = "A folder can't be moved to another space.";
export const FOLDER_CYCLE_MESSAGE = "A folder can't be moved into itself or one of its subfolders.";
export const FOLDER_DELETE_BLOCKED_MESSAGE = "The folder contains notes you can't delete.";
/** Also raised when `trashNotesInTx` reports notes no longer reachable (role changed after the recheck). */
export const FOLDER_CONTENT_CHANGED_MESSAGE = "The folder's contents just changed. Try again.";
export const FOLDER_NOT_EMPTY_MESSAGE = "The folder isn't empty, so it wasn't deleted.";
/** Must match the note routes' 404 text exactly, so placement doesn't reveal that a note exists. */
export const NOTE_NOT_FOUND_MESSAGE = "No note with that id.";
export const NOTE_PLACE_FORBIDDEN_MESSAGE = "You don't have permission to organize this note.";
export const NOTE_FOLDER_CROSS_SPACE_MESSAGE = "A note can't go into a folder in another space.";
export const NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE = "Your role in this group can't put notes in folders.";
