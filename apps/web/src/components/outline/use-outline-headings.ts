import { useEffect, useRef, useState } from "react";
import { extractHeadings, sameHeadings, type OutlineBlockLike, type OutlineHeading } from "./headings";

export interface OutlineEditorLike {
  readonly document: readonly OutlineBlockLike[];
  onChange(listener: () => void): (() => void) | void;
}

/** Quiet period after the last document change before the heading list is recomputed. */
export const OUTLINE_RECOMPUTE_MS = 300;

const EMPTY: readonly OutlineHeading[] = [];

/**
 * Heading list of the editor document. The change listener only (re)arms a timer, so typing never
 * walks the document; the list is recomputed once typing pauses, and the previous array is kept
 * when nothing visible changed so consumers do not re-render.
 */
export function useOutlineHeadings(editor: OutlineEditorLike | null): readonly OutlineHeading[] {
  const [headings, setHeadings] = useState<readonly OutlineHeading[]>(EMPTY);

  const latest = useRef<readonly OutlineHeading[]>(EMPTY);

  useEffect(() => {
    if (!editor) {
      if (latest.current.length > 0) {
        latest.current = EMPTY;
        setHeadings(EMPTY);
      }
      return;
    }
    // Compare outside the updater: a no-op updater can still cost one extra render.
    const recompute = () => {
      const next = extractHeadings(editor.document);
      if (!sameHeadings(latest.current, next)) {
        latest.current = next;
        setHeadings(next);
      }
    };
    recompute();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = editor.onChange(() => {
      clearTimeout(timer);
      timer = setTimeout(recompute, OUTLINE_RECOMPUTE_MS);
    });
    return () => {
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [editor]);

  return headings;
}
