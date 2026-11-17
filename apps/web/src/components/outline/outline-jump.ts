import { scrollToBlock } from "@/hooks/useBlockAnchor";
import { collapsedAncestors, COLLAPSED_TOGGLE } from "@/hooks/block-find";
import { headingElement } from "./active-heading";

/**
 * Opens every collapsed toggle that contains the target, outermost first, so the target is laid out.
 * The target's own toggle is left alone. The open state lives in the editor's own storage with no API,
 * so this clicks the same button a reader would; it also works in a read-only editor.
 * Returns how many toggles were opened.
 */
export function revealCollapsedAncestors(root: HTMLElement, blockId: string): number {
  const target = headingElement(root, blockId);
  if (!target) return 0;
  let opened = 0;
  for (const a of collapsedAncestors(root, target)) {
    const button = a.querySelector<HTMLElement>(`${COLLAPSED_TOGGLE} > .bn-toggle-button`);
    if (button) {
      button.click();
      opened++;
    }
  }
  return opened;
}

/** Opens collapsed ancestors, then scrolls the heading to the top with the usual flash. Returns the cancel. */
export function jumpToHeading(root: HTMLElement, blockId: string): () => void {
  revealCollapsedAncestors(root, blockId);
  return scrollToBlock(root, blockId);
}
