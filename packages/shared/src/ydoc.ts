export const YDOC_FRAGMENT = "knotebook";

// Encoded empty Y.Doc, returned when a note has no stored state: `Y.applyUpdate` throws on a zero-length update.
// A server unit test checks the literal independently, since server and web both import it.
export const EMPTY_YDOC_UPDATE_B64 = "AAA=";
