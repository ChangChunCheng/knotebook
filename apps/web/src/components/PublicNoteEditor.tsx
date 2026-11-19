// Deliberate: the public page must not rely on NoteEditor being loaded for BlockNote styles. Zero cost: both modules share the BlockNote chunk.
import "@blocknote/mantine/style.css";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { PublicLinkDto } from "@knotebook/shared";
import { buildReadonlyNoteEditorOptions } from "@/collab/editor-options";
import type { OutlineEditorLike } from "@/components/outline/use-outline-headings";
import { WikilinkContext, type WikilinkMode } from "@/components/wikilink/context";
import { publicRefIdentity, type PublicNoteRef } from "@/lib/public-note-ref";
import { useTheme } from "@/theme";

export interface PublicNoteEditorProps {
  doc: Y.Doc;
  publicRef: PublicNoteRef;
  links: readonly PublicLinkDto[];
  onEditor?: (editor: OutlineEditorLike | null) => void;
}

/** Split from `NoteEditor` because BlockNote needs DOM APIs jsdom lacks. Never mounts useCollab or calls collab-token (no noteId). */
export function PublicNoteEditor({ doc, publicRef, links, onEditor }: PublicNoteEditorProps) {
  const { i18n } = useTranslation();
  const { resolvedTheme } = useTheme();

  // Local Awareness: BlockNote only takes `{ awareness }`; destroy on unmount because the constructor starts a timer. Under StrictMode (dev only) the discarded first instance lives until unmount and the survivor is destroyed once by the simulated unmount and reused; accepted (read-only page has no peers, production does not double-run).
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  useEffect(() => () => awareness.destroy(), [awareness]);

  // Depend on an identity string, not the `publicRef` object, so rebuilds do not rely on caller memoization. A ref change within one mount cannot happen today (new ref -> new query key -> unmount); these deps do not vouch for that path.
  const refIdentity = publicRefIdentity(publicRef);
  const editor = useCreateBlockNote(
    buildReadonlyNoteEditorOptions({ doc, awareness, publicRef, language: i18n.language }),
    // Language is not in deps: the dictionary is read once at creation.
    [doc, awareness, refIdentity],
  );
  // Read via ref so a new callback each render does not report null then re-report.
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    // Captured so cleanup reports to the same callback.
    const report = onEditorRef.current;
    report?.(editor);
    return () => report?.(null);
  }, [editor]);
  const mode = useMemo<WikilinkMode>(() => ({ mode: "public", links: new Map(links.map((l) => [l.id.toLowerCase(), l])) }), [links]);

  return (
    <WikilinkContext.Provider value={mode}>
      <BlockNoteView editor={editor} editable={false} theme={resolvedTheme} data-testid="public-note-editor" />
    </WikilinkContext.Provider>
  );
}
