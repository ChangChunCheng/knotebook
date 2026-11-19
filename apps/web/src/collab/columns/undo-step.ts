import type { BlockNoteEditor } from "@blocknote/core";
import { collabUndoManager } from "@/collab/undo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

// Non-collab editors (the `history` extension) have no UndoManager and only run `run`.
export function asUndoStep<T>(editor: AnyEditor, run: () => T): T {
  const manager = collabUndoManager(editor);
  manager?.stopCapturing();
  try {
    return run();
  } finally {
    manager?.stopCapturing();
  }
}
