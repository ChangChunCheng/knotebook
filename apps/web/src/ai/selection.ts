import { getNodeById, type BlockNoteEditor } from "@blocknote/core";
import { isNodeSelection, isTextSelection } from "@tiptap/core";
import { escapeLinkText, FOCUS_MAX_CODE_POINTS, normalizeAnchor, truncateCodePoints, wikilinkHref, wikilinkVisibleText } from "@knotebook/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

/** Callers use `editor.transact((tr) => fn(tr, …))`; a read-only tr is never dispatched. */
export type PMLike = Pick<AnyEditor["prosemirrorState"], "doc" | "selection">;
type PMNode = PMLike["doc"];

export interface BlockRange {
  from: number;
  to: number;
}

export function blockRange(doc: PMNode, blockId: string): BlockRange | null {
  const info = getNodeById(blockId, doc);
  return info ? { from: info.posBeforeNode, to: info.posBeforeNode + info.node.nodeSize } : null;
}

export function anchorRange(doc: PMNode, blockIds: readonly string[]): BlockRange | null {
  if (blockIds.length === 0) return null;
  const first = blockRange(doc, blockIds[0]);
  const last = blockRange(doc, blockIds[blockIds.length - 1]);
  return first && last ? { from: first.from, to: last.to } : null;
}

// Copies the conditions of BlockNote 0.52.1's private FormattingToolbarExtension.shouldShow. Don't use the toolbar
// store instead: it is false during pointerdown and no selection change follows pointerup, so drag-selects are missed.
export function toolbarWouldShow({ doc, selection }: PMLike): boolean {
  if (selection.empty) return false;
  if (isTextSelection(selection) && doc.textBetween(selection.from, selection.to).length === 0) return false;
  let spansCode = false;
  selection.content().content.descendants((node) => {
    if (node.type.spec.code) spansCode = true;
    return !spansCode;
  });
  return !spansCode;
}

// CellSelection is detected by `$anchorCell` because prosemirror-tables isn't a direct dependency.
export function isNonTextSelection({ selection }: Pick<PMLike, "selection">): boolean {
  return isNodeSelection(selection) || "$anchorCell" in selection;
}

// Partial overlap counts as outside. Clamped to the root blockGroup's content [1, size − 1] because Ctrl+A's
// AllSelection spans 0..size and would otherwise never be inside.
export function selectionInsideAnchor({ doc, selection }: PMLike, blockIds: readonly string[]): boolean {
  const range = anchorRange(doc, blockIds);
  if (!range) return false;
  const from = Math.max(selection.from, 1);
  const to = Math.min(selection.to, doc.content.size - 1);
  return from >= range.from && to <= range.to;
}

export function leafText(node: PMNode, titleOf?: (id: string) => string | undefined): string {
  if (node.type.name === "wikilink") {
    const id = String(node.attrs.targetNoteId ?? "");
    const href = wikilinkHref(id, normalizeAnchor(node.attrs.anchorBlockId));
    return `[${escapeLinkText(wikilinkVisibleText(node.attrs, titleOf?.(id)))}](${href})`;
  }
  if (node.type.name === "hardBreak") return "\n";
  return node.textContent;
}

// "" when the selection covers all of the anchor's text (triple-click, a whole drag and Ctrl+A all compare equal).
export function selectionFocus({ doc, selection }: PMLike, blockIds: readonly string[], titleOf?: (id: string) => string | undefined): string {
  const leaf = (node: PMNode) => leafText(node, titleOf);
  const selected = doc.textBetween(selection.from, selection.to, "\n", leaf);
  const range = anchorRange(doc, blockIds);
  if (range && selected === doc.textBetween(range.from, range.to, "\n", leaf)) return "";
  return truncateCodePoints(selected, FOCUS_MAX_CODE_POINTS);
}
