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
 * when nothing visible changed so consumers do not re-render. The one exception is the first change
 * of an editor whose list is still empty (its initial content arriving), which is computed at once.
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

    // A collaborative note's editor starts empty and its content arrives as the first change. That first
    // change is computed right away, so the outline (and a pinned column) shows with the content instead of
    // a quiet period later. Only while the list is still empty, and only once: an editor that already had
    // headings, and everything after the first change, stays on the timer.
    let first = latest.current.length === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = editor.onChange(() => {
      clearTimeout(timer);
      if (first) {
        first = false;
        recompute();
        return;
      }
      timer = setTimeout(recompute, OUTLINE_RECOMPUTE_MS);
    });
    return () => {
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [editor]);

  return headings;
}
