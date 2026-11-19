import { createContext, useContext, useLayoutEffect } from "react";
import type { BlockAnchorApi } from "@/hooks/block-anchor-context";
import type { NotePageControls } from "@/lib/note-page-controls";

/**
 * The sidebar lives outside the page but needs the open note's controls and block-anchor API, so
 * the page registers them with the outer layer. In-page descendants read the in-page provider
 * directly to avoid render delay.
 */
export interface NotePageBridge {
  setControls: (controls: NotePageControls | null) => void;
  setAnchors: (anchors: BlockAnchorApi | null) => void;
}

export const NotePageBridgeContext = createContext<NotePageBridge | null>(null);

export function useRegisterNotePage(controls: NotePageControls | null, anchors: BlockAnchorApi): void {
  const bridge = useContext(NotePageBridgeContext);
  useLayoutEffect(() => {
    if (bridge === null) return;
    bridge.setControls(controls);
    return () => bridge.setControls(null);
  }, [bridge, controls]);
  useLayoutEffect(() => {
    if (bridge === null) return;
    bridge.setAnchors(anchors);
    return () => bridge.setAnchors(null);
  }, [bridge, anchors]);
}
