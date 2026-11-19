import * as Y from "yjs";

/**
 * Throws on bad input on purpose: PublicNoteErrorBoundary shows an error card, whereas an empty
 * doc would render corruption as a normal empty note. An empty document is
 * `EMPTY_YDOC_UPDATE_B64` (`AAA=`); a zero-length update would throw.
 */
export function decodePublicYdoc(base64: string): Y.Doc {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}
