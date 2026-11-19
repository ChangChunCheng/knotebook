// The three pixel constants equal the columns section of `index.css` (`gap`, two `min-width`s); change both together (`columns-css.guard.test.ts` compares them).
import { COLUMN_TYPE } from "@knotebook/shared";

export const COLUMN_GAP_PX = 24;
export const COLUMN_MIN_TEXT_PX = 200;
export const COLUMN_MIN_IMAGE_PX = 96;

export type ColumnKind = "image" | "text";

export interface PMNodeLike {
  type: { name: string };
  attrs: Record<string, unknown>;
  childCount: number;
  firstChild: PMNodeLike | null;
  nodeSize: number;
  forEach(f: (node: PMNodeLike, offset: number) => void): void;
}

// An image with `showPreview:false` is drawn as a file row (and exported by presentations as `<a>`), so it counts as text.
export function columnKindOf(column: PMNodeLike): ColumnKind {
  if (column.type.name !== COLUMN_TYPE || column.childCount === 0) return "text";
  let allImages = true;
  column.forEach((container) => {
    const content = container.firstChild;
    if (container.childCount !== 1 || content?.type.name !== "image" || content.attrs.showPreview === false) allImages = false;
  });
  return allImages ? "image" : "text";
}

export function columnMinWidth(kind: ColumnKind): number {
  return kind === "image" ? COLUMN_MIN_IMAGE_PX : COLUMN_MIN_TEXT_PX;
}

export function shouldStack(kinds: readonly ColumnKind[], available: number, gap: number = COLUMN_GAP_PX): boolean {
  if (!(available > 0)) return false;
  const needed = kinds.reduce((sum, kind) => sum + columnMinWidth(kind), 0) + gap * Math.max(0, kinds.length - 1);
  return needed > available;
}
