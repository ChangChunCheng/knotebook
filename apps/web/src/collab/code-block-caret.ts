/**
 * Sets `data-caret-inside` on the code block holding the caret. `:focus-within` can't do it: focus stays on the `.ProseMirror`
 * root, an ancestor of the block. Touch devices have no hover, so this is the only way to show the language dropdown.
 * Recomputed on focus changes because tiptap's focusEvents plugin dispatches a transaction. View-only: not in Yjs or the undo stack.
 */
import { Extension } from "@tiptap/core";
// Must be the same prosemirror-view copy BlockNote uses (the range mirrors BlockNote's on purpose): on a split, the view's
// `DecorationGroup.from` instanceof check rejects our DecorationSet and mounting throws a TypeError (`reading 'localsInner'`).
import { Decoration, DecorationSet } from "prosemirror-view";
import { createPmPlugin } from "./pm-plugin";

export const CARET_INSIDE_ATTR = "data-caret-inside";

interface CaretState {
  doc: Parameters<typeof DecorationSet.create>[0];
  selection: { $head: { parent: { type: { name: string } }; depth: number; before(): number; after(): number } };
}

// With the whole block selected (NodeSelection) the head is outside the block, which doesn't count.
export function caretCodeBlockDecorations(state: CaretState, active: boolean): DecorationSet {
  const { $head } = state.selection;
  if (!active || $head.depth === 0 || $head.parent.type.name !== "codeBlock") return DecorationSet.empty;
  return DecorationSet.create(state.doc, [Decoration.node($head.before(), $head.after(), { [CARET_INSIDE_ATTR]: "true" })]);
}

export function createCodeBlockCaretExtension(): Extension {
  return Extension.create({
    name: "knotebookCodeBlockCaret",
    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        // Editable and focused only: read-only has no languages to pick, and after blur the caret stays but the dropdown shouldn't float.
        createPmPlugin({
          props: { decorations: (state) => caretCodeBlockDecorations(state, editor.isEditable && editor.isFocused) },
        }) as never,
      ];
    },
  });
}
