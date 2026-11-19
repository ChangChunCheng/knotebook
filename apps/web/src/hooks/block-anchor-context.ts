import { createContext } from "react";

// `currentNoteId` is null on public pages: their payload deliberately omits the note id.
export interface BlockAnchorApi {
  currentNoteId: string | null;
  /** Re-scrolls even for the same anchor. `findText` targets the section's first block containing it (`blockId` may be `_top`). */
  requestAnchor(blockId: string, findText?: string): void;
  scrollToTop(): void;
}

export const NO_BLOCK_ANCHOR: BlockAnchorApi = { currentNoteId: null, requestAnchor: () => {}, scrollToTop: () => {} };

export const BlockAnchorContext = createContext<BlockAnchorApi>(NO_BLOCK_ANCHOR);
