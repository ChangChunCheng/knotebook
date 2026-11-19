/**
 * Without this, a link with no custom text would be frozen into custom text on write-back:
 * it exports as `[title at that time](/notes/<id>)`, and if the target is renamed after
 * download and the agent edits that section, the old title would be stored as a label. So
 * download records a salted hash of each such link's exported text (in the base segment
 * table's `links`, no migration) and write-back treats a matching text as "no custom text".
 * Only links with an empty `label` are recorded; bases downloaded before this use the old rule.
 */
import { mapInlineArrays, wikilinkVisibleText, type WikilinkProps } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import { hmacOf } from "./base-hash.js";

const LINK_HASH_BYTES = 8;

export function linkTextHash(key: Buffer, salt: Buffer, targetId: string, text: string): string {
  // `\0` separators keep the id and the text from bleeding into each other.
  return hmacOf(key, salt, `wikilink\0${targetId.toLowerCase()}\0${text}`).subarray(0, LINK_HASH_BYTES).toString("hex");
}

export function labelFreeLinkTexts(blocks: readonly unknown[], titles: ReadonlyMap<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  mapInlineArrays([...blocks], inline => {
    for (const node of inline) {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") continue;
      const props = n.props ?? {};
      if (typeof props.label === "string" && props.label !== "") continue;
      const id = String(props.targetNoteId ?? "").toLowerCase();
      out.push([id, wikilinkVisibleText(props, titles.get(id))]);
    }
    return inline;
  });
  return out;
}

/** Merged across all segments: a target exports one title note-wide, so a link moved to another segment is still recognized. */
export function exportedLinkTextOf(segments: readonly TransferSegment[], key: Buffer, salt: Buffer): ((targetId: string, text: string) => boolean) | undefined {
  const set = new Set<string>();
  for (const s of segments) for (const h of s.links ?? []) set.add(h);
  if (set.size === 0) return undefined;
  return (targetId, text) => set.has(linkTextHash(key, salt, targetId, text));
}

/** `snapshotTitle` becomes the target's current title, as the "text = current title" rule stores. Copy-on-write. */
export function keepLabelFree<B>(
  blocks: B[],
  exported: (targetId: string, text: string) => boolean,
  titleOf: (id: string) => string | undefined,
  onCleared?: (targetId: string, text: string) => void,
): [B[], number] {
  let cleared = 0;
  const out = mapInlineArrays(blocks, inline => {
    let changed = false;
    const next = inline.map(node => {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") return node;
      const props = n.props ?? {};
      const label = typeof props.label === "string" ? props.label : "";
      const id = String(props.targetNoteId ?? "");
      if (label === "" || !exported(id, label)) return node;
      changed = true;
      cleared++;
      onCleared?.(id.toLowerCase(), label);
      return { ...n, props: { ...props, label: "", snapshotTitle: titleOf(id) ?? props.snapshotTitle ?? label } };
    });
    return changed ? next : inline;
  });
  return [out, cleared];
}
