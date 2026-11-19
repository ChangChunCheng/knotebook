import type { EditorView } from "prosemirror-view";
import { isNodeSelection } from "@tiptap/core";

const IMAGE_CONTENT = '.bn-block-content[data-content-type="image"]';
const OWN_CONTENT = ":scope > .bn-block > .bn-block-content, :scope > .bn-block-content";

/** Only the selected node's own level counts: selecting an outer block must not return a nested child block's image. */
export function selectedImageOf(view: EditorView | undefined): HTMLImageElement | null {
  if (!view) return null;
  const { selection } = view.state;
  if (!isNodeSelection(selection)) return null;
  const dom = view.nodeDOM(selection.from);
  if (!(dom instanceof HTMLElement)) return null;
  const content = dom.matches(IMAGE_CONTENT)
    ? dom
    : Array.from(dom.querySelectorAll<HTMLElement>(OWN_CONTENT)).find((el) => el.matches(IMAGE_CONTENT));
  return content?.querySelector<HTMLImageElement>("img.bn-visual-media") ?? null;
}
