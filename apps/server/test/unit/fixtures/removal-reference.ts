import * as Y from "yjs";
import type { EditingRuntime } from "../../../src/notes/editing/runtime.js";
import { EditorSession, renameBlocksInDoc, type AnyEditor } from "../../../src/notes/editing/session.js";

/** The fork's `clientID` is set before the base is applied, so the same writes produce the same structs and the diffs can be compared byte for byte. */
export function forkWithClient(state: Uint8Array, clientID: number): { fork: Y.Doc; sv: Uint8Array } {
  const fork = new Y.Doc();
  fork.clientID = clientID;
  Y.applyUpdate(fork, state);
  return { fork, sv: Y.encodeStateVector(fork) };
}

/** Removal through the editor, as the write paths did before removal moved to the Yjs layer: `steps` run inside one session, renames (if returned) after close. */
export async function referenceWrite(
  rt: EditingRuntime,
  state: Uint8Array,
  clientID: number,
  steps: (ed: AnyEditor) => ReadonlyMap<string, string> | void
): Promise<{ doc: Y.Doc; diff: Uint8Array }> {
  const { fork, sv } = forkWithClient(state, clientID);
  const s = await EditorSession.open(rt, fork);
  let renames: ReadonlyMap<string, string> | void;
  try {
    renames = steps(s.editor);
  } finally {
    s.close();
  }
  if (renames) renameBlocksInDoc(fork, renames);
  return { doc: fork, diff: Y.encodeStateAsUpdate(fork, sv) };
}
