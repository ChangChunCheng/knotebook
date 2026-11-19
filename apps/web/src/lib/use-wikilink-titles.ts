import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { sameNoteId } from "./note-id";
import type { DiffBlock } from "./version-diff";

function visitInline(inline: unknown, out: Set<string>): void {
  if (!Array.isArray(inline)) return;
  for (const n of inline as Array<{ type?: unknown; props?: { targetNoteId?: unknown } }>) {
    if (n?.type === "wikilink" && typeof n.props?.targetNoteId === "string") out.add(n.props.targetNoteId);
  }
}

export function wikilinkIdsIn(blocks: readonly DiffBlock[] | null | undefined, out: Set<string>): void {
  for (const b of blocks ?? []) {
    const content = b.content as { type?: unknown; rows?: Array<{ cells?: unknown[] }> } | unknown[] | undefined;
    if (Array.isArray(content)) visitInline(content, out);
    else if (content && typeof content === "object" && content.type === "tableContent") {
      for (const row of content.rows ?? []) for (const cell of row.cells ?? []) visitInline(Array.isArray(cell) ? cell : (cell as { content?: unknown })?.content, out);
    }
    wikilinkIdsIn(b.children, out);
  }
}

const noop = () => () => {};

/**
 * #269: keyed by the sorted serialized `[id, title]` pairs, so a refetch with unchanged titles returns the same function
 * and `DiffEditor` is not rebuilt (VersionPreview must not jump to the top). Ids are compared with `sameNoteId` (old
 * documents may store `targetNoteId` in uppercase).
 */
export function useWikilinkTitleOf(a: readonly DiffBlock[] | null | undefined, b: readonly DiffBlock[] | null | undefined): (id: string) => string | undefined {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback((cb: () => void) => (client ? client.getQueryCache().subscribe(cb) : noop()), [client]);
  const notes = useSyncExternalStore(subscribe, () => client?.getQueryData<NoteDto[]>(["notes"]));
  const ids = useMemo(() => {
    const s = new Set<string>();
    wikilinkIdsIn(a, s);
    wikilinkIdsIn(b, s);
    return [...s].sort();
  }, [a, b]);
  const key = useMemo(() => JSON.stringify(ids.map((id) => [id, notes?.find((n) => sameNoteId(n.id, id))?.title ?? null])), [ids, notes]);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, title] of JSON.parse(key) as Array<[string, string | null]>) if (title !== null) map.set(id, title);
    return (id: string) => map.get(id);
  }, [key]);
}
