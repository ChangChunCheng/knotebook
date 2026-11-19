// AI edits are made on a fork and only the fork's diff against its own state vector is merged back, so concurrent typing survives. `withDirectConnection` is the only direct connection, opened just to merge.
// `openDirectConnection` bypasses `onAuthenticate`: callers must check write permission first. `disconnect()` is the persist point, and `fn` must be all-or-nothing (ops yjs already applied aren't undone and get persisted).
// #181: the note may be trashed after authorization, so liveness is rechecked before opening (don't load a trashed doc into memory) and after (a move landing at open). Hocuspocus doesn't unload while a direct connection holds the doc, so the move's unload polling waits for this write; the remaining window is that polling's 5 s timeout (known-limitations).
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { DirectConnection, Document, Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import type { CollabContext, CollabServer } from "../../collab/server.js";
import type { DbOrTx } from "../../db/tx.js";
import { noteIsLive } from "../service.js";
import type { EditingRuntime, SessionLease } from "./runtime.js";

/**
 * Inserts after the old last block, then deletes the old blocks. `replaceBlocks` in one transaction makes y-prosemirror diff new paragraphs against old ones (Yjs splices the whole structure array per split: 49,000 `<br>` → 24,500 formatted takes 12 s vs 0.85 s). After the last block rather than before the first, so the insertion origin is inside the old section: before the first block it shares an origin with a paragraph a browser types at the end of the previous section, and the client id could move that paragraph into the target section.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple
export function replaceBlocksFresh(editor: BlockNoteEditor<any, any, any>, ids: string[], blocks: Parameters<BlockNoteEditor<any, any, any>["insertBlocks"]>[0]): { id: string }[] {
  const inserted = blocks.length === 0 ? [] : editor.insertBlocks(blocks, ids[ids.length - 1]!, "after");
  editor.removeBlocks(ids);
  return inserted;
}

export function forkFrom(source: Y.Doc | Uint8Array): { fork: Y.Doc; sv: Uint8Array } {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, source instanceof Y.Doc ? Y.encodeStateAsUpdate(source) : source);
  return { fork, sv: Y.encodeStateVector(fork) };
}

// Callers must `close()` in a finally: it's the only path releasing the runtime lease, and a leak would block the rebuild gate forever. Never `open()` while holding a lease (`acquire()` isn't reentrant).
export class EditorSession {
  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention
    readonly editor: BlockNoteEditor<any, any, any>,
    private readonly fork: Y.Doc,
    private readonly lease: SessionLease
  ) {}

  static async open(runtime: EditingRuntime, fork: Y.Doc): Promise<EditorSession> {
    const lease = await runtime.acquire();
    try {
      const editor = BlockNoteEditor.create(
        withCollaboration({
          schema: createHeadlessNoteSchema(runtime.baseUrl),
          collaboration: { fragment: fork.getXmlFragment(YDOC_FRAGMENT), user: { name: "ai", color: "#7c3aed" } },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above: the createHeadlessNoteSchema triple is not propagated here
      ) as BlockNoteEditor<any, any, any>;
      editor.mount(document.createElement("div"));
      runtime.noteMount();
      return new EditorSession(editor, fork, lease);
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  diffSince(sv: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.fork, sv);
  }

  close(): void {
    try {
      this.editor.unmount();
    } finally {
      this.lease.release();
    }
  }
}

export interface DirectCtx extends CollabContext {
  /** `version-apply`: writes no note_ai_edits and cuts no version. */
  source: "ai-edit" | "version-apply";
  tokenId: string | null;
  agentLabel: string | null;
  applied: boolean;
}

/** No userId: collab's `stampLastEdited` and editor accumulation gate on a string `userId`, so conversions stamp nothing and count no activity; versions treat it as the "other" branch. */
export interface LinkConvertCtx {
  source: "link-convert";
  applied: boolean;
}

export type DirectConnectionCtx = DirectCtx | LinkConvertCtx;

export class NoteGoneError extends Error {
  override name = "NoteGoneError";
}

export interface DirectTarget {
  hocuspocus: Hocuspocus<CollabContext>;
  isDeleting(noteId: string): boolean;
  noteIsLive(noteId: string): Promise<boolean>;
}

export function directTarget(collab: Pick<CollabServer, "hocuspocus" | "isDeleting">, db: DbOrTx): DirectTarget {
  return {
    hocuspocus: collab.hocuspocus,
    isDeleting: noteId => collab.isDeleting(noteId),
    noteIsLive: noteId => noteIsLive(db, noteId),
  };
}

async function goneNow(target: DirectTarget, noteId: string): Promise<boolean> {
  return target.isDeleting(noteId) || !(await target.noteIsLive(noteId));
}

async function disconnectQuietly(direct: DirectConnection): Promise<void> {
  try {
    await direct.disconnect();
  } catch (err) {
    console.error("withDirectConnection: disconnect after recheck failed", err);
  }
}

/** `fn`'s error wins: a disconnect failure is only logged, or the caller would misclassify (e.g. "AI content invalid" as "persist failed"). `beforeDisconnect` failures are likewise only logged (content applied, base not updated: acceptable). */
export async function withDirectConnection<T>(
  target: DirectTarget,
  noteId: string,
  ctx: DirectConnectionCtx,
  fn: (doc: Document) => T,
  opts?: { beforeDisconnect?: (result: T) => Promise<void>; afterOpen?: () => Promise<void> }
): Promise<T> {
  if (await goneNow(target, noteId)) throw new NoteGoneError();
  const direct = await target.hocuspocus.openDirectConnection(noteId, ctx as unknown as CollabContext);
  let gone: boolean;
  try {
    gone = await goneNow(target, noteId);
  } catch (err) {
    await disconnectQuietly(direct);
    throw err;
  }
  if (gone) {
    // Hocuspocus 4.5 `disconnect()` can't skip persisting; storing an unchanged doc is harmless.
    await disconnectQuietly(direct);
    throw new NoteGoneError();
  }
  if (opts?.afterOpen) {
    try {
      await opts.afterOpen();
    } catch (err) {
      await disconnectQuietly(direct);
      throw err;
    }
  }
  let result!: T;
  let fnFailed = false;
  let fnError: unknown;
  try {
    await direct.transact(doc => {
      result = fn(doc);
    });
  } catch (err) {
    fnFailed = true;
    fnError = err;
  }
  if (!fnFailed && opts?.beforeDisconnect) {
    try {
      await opts.beforeDisconnect(result);
    } catch (bdErr) {
      console.error("withDirectConnection: beforeDisconnect failed", bdErr);
    }
  }
  try {
    await direct.disconnect();
  } catch (disconnectErr) {
    if (!fnFailed) throw disconnectErr;
    console.error("withDirectConnection: disconnect after fn error failed", disconnectErr);
  }
  if (fnFailed) throw fnError;
  return result;
}
