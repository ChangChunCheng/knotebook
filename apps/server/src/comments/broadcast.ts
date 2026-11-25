import type { CollabServer } from "../collab/server.js";

export type CommentChangeOp = "created" | "edited" | "deleted";

/**
 * Tells everyone with the note open that a comment changed; they fetch it themselves, so the message carries no text and a connection
 * that lost access in the meantime learns nothing. Call only after the transaction committed. Does nothing when the document isn't
 * loaded: nobody is connected, and a client that connects later refetches on sync.
 */
export function broadcastCommentChange(collab: CollabServer | undefined, noteId: string, op: CommentChangeOp, commentId: string): void {
  collab?.hocuspocus.documents.get(noteId)?.broadcastStateless(JSON.stringify({ type: "comment", op, commentId }));
}
