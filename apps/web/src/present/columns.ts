import { shouldStack, type ColumnKind } from "@/collab/columns/layout";

/** Writes only `data-stacked`; measured at render time only, not recomputed on window resize. */
const ROW_SELECTOR = "[data-kb-columns]";
const COLUMN_SELECTOR = ":scope > [data-kb-column]";
const STACKED_ATTR = "data-stacked";

function columnKind(column: Element): ColumnKind {
  const children = Array.from(column.children);
  return children.length > 0 && children.every((child) => child.matches("figure, img")) ? "image" : "text";
}

export function markStackedColumnRows(root: ParentNode, availableWidth: number): void {
  if (!(availableWidth > 0)) return;
  for (const row of Array.from(root.querySelectorAll(ROW_SELECTOR))) {
    const kinds = Array.from(row.querySelectorAll(COLUMN_SELECTOR)).map(columnKind);
    row.toggleAttribute(STACKED_ATTR, shouldStack(kinds, availableWidth));
  }
}

export function restackSlideBody(body: HTMLElement): void {
  if (!body.isConnected) return;
  markStackedColumnRows(body, body.clientWidth);
}
