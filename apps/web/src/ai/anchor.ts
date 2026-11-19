import type { BlockNoteEditor } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

// A string, not a hash: WebCrypto is undefined outside secure contexts (plain-http LAN is supported), and
// async would break the fully synchronous check → replaceBlocks.
export function blockSnapshot(editor: AnyEditor, blockId: string): string | null {
  const block = editor.getBlock(blockId);
  return block === undefined ? null : JSON.stringify(block);
}

export interface AiAnchor {
  noteId: string;
  blockIds: string[];
  snapshots: string[];
}

export function captureAnchor(editor: AnyEditor, noteId: string, blockIds: string[]): AiAnchor {
  return { noteId, blockIds, snapshots: blockIds.map((id) => blockSnapshot(editor, id) ?? "") };
}

export function verifyAnchor(editor: AnyEditor, anchor: AiAnchor): "ok" | "missing" | "changed" {
  for (let i = 0; i < anchor.blockIds.length; i += 1) {
    const now = blockSnapshot(editor, anchor.blockIds[i]);
    if (now === null) return "missing";
    if (now !== anchor.snapshots[i]) return "changed";
  }
  return "ok";
}
