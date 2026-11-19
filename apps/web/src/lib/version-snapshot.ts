import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { DiffBlock } from "./version-diff";

/**
 * Does not mount and does not attach collaboration: `yXmlFragmentToBlocks` uses only the editor's ProseMirror schema.
 * Never mount a collaboration editor on the live fragment: it would write its normalized result back into the live
 * document (an empty note gets an empty paragraph synced to the server), so previewing would modify the note.
 * The read path is not read-only either: y-prosemirror's `createNodeFromYElement` deletes Y nodes of types the schema
 * does not know and merges adjacent Y.Text nodes of the local clientID, inside `el.doc.transact`. Hence the "current
 * state" must be forked first (see `forkLiveBlocks`).
 */
let reader: BlockNoteEditor<typeof noteSchema.blockSchema, typeof noteSchema.inlineContentSchema, typeof noteSchema.styleSchema> | null = null;
function getReader() {
  reader ??= BlockNoteEditor.create({ schema: noteSchema });
  return reader;
}

function blocksOf(doc: Y.Doc): DiffBlock[] {
  return yXmlFragmentToBlocks(getReader(), doc.getXmlFragment(YDOC_FRAGMENT)) as unknown as DiffBlock[];
}

export function ydocBytesToBlocks(bytes: Uint8Array): DiffBlock[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return blocksOf(doc);
  } finally {
    doc.destroy();
  }
}

/** The fork is load-bearing: the read path may write back, and that happens only on the fork, so the live document gets zero writes. */
export function forkLiveBlocks(live: Y.Doc): DiffBlock[] {
  return ydocBytesToBlocks(Y.encodeStateAsUpdate(live));
}
