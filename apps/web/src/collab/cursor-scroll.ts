import * as Y from "yjs";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import type { BlockNoteEditor } from "@blocknote/core";
import { scrollsPage, stickyTopInset } from "@/lib/page-scroll";

/**
 * Follows `createDecorations` in y-prosemirror 1.3.7 `plugins/cursor-plugin.js` (same `ySync` state, same `relativePositionToAbsolutePosition`, same early exits).
 * The plugin comes from `editor.getExtension("ySync")`, **not importing `ySyncPluginKey`**: same reason as `collabUndoManager` in `collab/undo.ts` (two pnpm copies of y-prosemirror give mismatched PluginKeys).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

export type CursorScroller = (cursor: unknown) => boolean;

interface YSyncState {
  doc?: Y.Doc;
  type?: Y.XmlFragment;
  binding?: { mapping: Map<unknown, unknown> } | null;
  snapshot?: unknown;
  prevSnapshot?: unknown;
}

export function cursorHeadPosition(editor: AnyEditor, cursor: unknown): number | null {
  if (typeof cursor !== "object" || cursor === null) return null;
  const head = (cursor as { head?: unknown }).head;
  if (head == null) return null;
  const plugin = editor.getExtension("ySync")?.prosemirrorPlugins?.[0];
  const ystate = plugin?.getState(editor.prosemirrorState) as YSyncState | undefined;
  // Early exits copied from y-prosemirror's createDecorations (the binding is never null in 1.3.7; the extra check is defensive).
  if (
    !ystate?.doc ||
    !ystate.type ||
    !ystate.binding ||
    ystate.binding.mapping.size === 0 ||
    ystate.snapshot != null ||
    ystate.prevSnapshot != null
  ) {
    return null;
  }
  let pos: number | null;
  try {
    pos = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      Y.createRelativePositionFromJSON(head),
      ystate.binding.mapping as never,
    );
  } catch {
    return null;
  }
  if (pos === null) return null;
  return Math.min(Math.max(pos, 0), editor.prosemirrorState.doc.content.size);
}

// On phones the document scrolls, not the container (`lib/page-scroll.ts`): scroll the document instead, to 1/3 of the visible height below the header.
export function createCursorScroller({ editor, getRoot }: { editor: AnyEditor; getRoot: () => HTMLElement | null }): CursorScroller {
  return (cursor) => {
    const root = getRoot();
    if (!root) return false;
    const pos = cursorHeadPosition(editor, cursor);
    if (pos === null) return false;
    let coords: { top: number };
    try {
      coords = editor.prosemirrorView.coordsAtPos(pos);
    } catch {
      return false;
    }
    if (scrollsPage(root)) {
      const header = stickyTopInset();
      const top = window.scrollY + coords.top - header - (window.innerHeight - header) / 3;
      window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "smooth" });
      return true;
    }
    const top = root.scrollTop + (coords.top - root.getBoundingClientRect().top) - root.clientHeight / 3;
    root.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "smooth" });
    return true;
  };
}
