import { mapTableCell, TableHandlesExtension, type BlockNoteEditor, type TableContent } from "@blocknote/core";
import { canonicalColor } from "@knotebook/shared";
import { ensureCustomColor } from "@/lib/custom-colors";
import { sectionProp, type ColorSection, type ColorTarget } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

type TableTarget = Extract<ColorTarget, { kind: "cell" | "rowcol" }>;

/** Reads the latest block at apply time and rebuilds rows, so words co-editors changed while the panel was open aren't overwritten by stale content. */
function applyToTable(editor: AnyEditor, prop: "textColor" | "backgroundColor", target: TableTarget, canon: string): boolean {
  const block = editor.getBlock(target.blockId);
  if (!block || block.type !== "table") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic table content (repo convention)
  const content = block.content as TableContent<any, any>;
  const rows = content.rows.map((r) => ({ ...r, cells: r.cells.map((c) => mapTableCell(c)) }));
  let coords: { row: number; col: number }[];
  if (target.kind === "cell") {
    if (!rows[target.rowIndex]?.cells[target.colIndex]) return false;
    coords = [{ row: target.rowIndex, col: target.colIndex }];
  } else {
    const handles = editor.getExtension(TableHandlesExtension);
    if (!handles) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- block generic differs from the getCellsAt* parameter types
    const hit = target.orientation === "row" ? handles.getCellsAtRowHandle(block as any, target.index) : handles.getCellsAtColumnHandle(block as any, target.index);
    coords = hit.filter((h) => rows[h.row]?.cells[h.col]).map((h) => ({ row: h.row, col: h.col }));
  }
  if (coords.length === 0) return false;
  if (canon.startsWith("#")) ensureCustomColor("block", prop, canon);
  for (const { row, col } of coords) {
    const cell = rows[row]!.cells[col]!;
    cell.props = { ...cell.props, [prop]: canon };
  }
  editor.updateBlock(block, { type: "table", content: { ...content, rows } });
  editor.setTextCursorPosition(block);
  return true;
}

/**
 * Inline target: true only means the colour was dispatched to the current selection (whether the selection accepts the style isn't checked); no focus here.
 * The rule kind is registered by where it was applied: inline registers only inline rules, block and cell targets only block rules.
 */
export function applyColor(editor: AnyEditor, section: ColorSection, target: ColorTarget, value: string): boolean {
  const canon = canonicalColor(value);
  if (canon === null) return false;
  const prop = sectionProp(section);
  if (target.kind === "cell" || target.kind === "rowcol") return applyToTable(editor, prop, target, canon);
  if (target.kind === "block") {
    const block = editor.getBlock(target.blockId);
    // Blocks lacking the prop (e.g. codeBlock has no backgroundColor) are not written by updateBlock, so no rule is registered either.
    if (!block || !(prop in block.props)) return false;
  }
  if (canon.startsWith("#")) ensureCustomColor(target.kind === "inline" ? "inline" : "block", prop, canon);
  if (target.kind === "inline") {
    if (canon === "default") editor.removeStyles({ [prop]: canon });
    else editor.addStyles({ [prop]: canon });
    return true;
  }
  editor.updateBlock(target.blockId, { props: { [prop]: canon } });
  return true;
}
