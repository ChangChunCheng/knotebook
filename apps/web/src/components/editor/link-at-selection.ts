import type { BlockNoteEditor } from "@blocknote/core";

/**
 * The link mark is non-inclusive: looking up at the selection start returns the previous node's mark (misses a selection that exactly covers the link, or a link at paragraph start),
 * so a non-collapsed selection looks one position after its start (as BlockNote's `editLink`). A collapsed cursor looks at its own position,
 * so cursors just outside the link aren't taken as inside. A selection extending past the link end doesn't count.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple (repo convention)
export function linkAtSelection(editor: BlockNoteEditor<any, any, any> | null | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM selection
  const sel = (editor as any)?._tiptapEditor?.state?.selection as { from: number; to: number; empty: boolean } | undefined;
  if (!editor || !sel) return undefined;
  const link = editor.getLinkMarkAtPos(sel.empty ? sel.from : sel.from + 1);
  return link && sel.from >= link.from && sel.to <= link.to ? link : undefined;
}
