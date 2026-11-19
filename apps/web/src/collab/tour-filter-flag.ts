// Imports nothing: this file is in the initial bundle (`lib/tour-bridge.ts` toggles it) while the
// plugin file pulls in tiptap/ProseMirror (note page chunk only). Enforced by `lib/tour-bridge.guard.test.ts`.

export const TOUR_TRANSACTION_META = "knotebook:tour";

const filtering = new WeakSet<object>();

/** Dispatches no transaction, so it is safe to call after the editor unmounted. */
export function setEditorTransactionFilterFlag(tiptapEditor: object, on: boolean): void {
  if (on) filtering.add(tiptapEditor);
  else filtering.delete(tiptapEditor);
}

export function isTourTransactionFilterOn(tiptapEditor: object): boolean {
  return filtering.has(tiptapEditor);
}
