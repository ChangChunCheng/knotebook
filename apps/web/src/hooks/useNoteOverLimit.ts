import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { noteStateBytes } from "@/lib/note-size-guard";

/** Encoding cost scales with note size, so re-measure at most this often (ms), not on every keystroke. */
export const NOTE_OVER_LIMIT_CHECK_MS = 3_000;

// While over the limit only deletions trigger a re-measure: additions can't bring it back under, and measuring
// an over-limit note costs about five encodes.
export function useNoteOverLimit(doc: Y.Doc | null, limitBytes: number | undefined, ready: boolean): boolean {
  const [over, setOver] = useState<{ doc: Y.Doc | null; limit: number | undefined; value: boolean }>({ doc: null, limit: undefined, value: false });

  useEffect(() => {
    if (doc === null || limitBytes === undefined || !ready) return;
    let isOver = false;
    let deletedSince = false;
    const measure = () => {
      deletedSince = false;
      isOver = noteStateBytes(doc, limitBytes) > limitBytes;
      setOver({ doc, limit: limitBytes, value: isOver });
    };
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = (tr: Y.Transaction) => {
      if (tr.deleteSet.clients.size > 0) deletedSince = true;
    };
    const onUpdate = () => {
      if (timer !== undefined) return;
      if (isOver && !deletedSince) return;
      timer = setTimeout(() => {
        timer = undefined;
        measure();
      }, NOTE_OVER_LIMIT_CHECK_MS);
    };
    // Yjs emits afterTransaction before update, so deletedSince is current in onUpdate.
    doc.on("afterTransaction", onTransaction);
    doc.on("update", onUpdate);
    return () => {
      doc.off("afterTransaction", onTransaction);
      doc.off("update", onUpdate);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [doc, limitBytes, ready]);

  return ready && over.doc === doc && over.limit === limitBytes && over.value;
}
