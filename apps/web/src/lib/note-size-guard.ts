import * as Y from "yjs";

/**
 * Soft check: the server does not check browser collab updates, so actions that insert a lot at
 * once (paste, drop, in-app AI apply) estimate "current size + growth" first. Typing is not
 * blocked and deletion is always allowed. The estimate's error can let a note slightly exceed the
 * limit; REST, MCP and batch write-back are still checked exactly by the server. When the raw
 * size would block, a garbage-collected copy is measured instead, because the UndoManager keeps
 * locally deleted tombstones that the server collects ({@link noteStateBytes}).
 */

/**
 * Approximate Yjs bytes per block-level element node, empirically: paragraph block ~210 (two
 * nodes), list item ~215, table cell ~200; every node carries an id and default attributes
 * regardless of text. 105 gives ~1.0x for paragraphs and lists.
 */
export const PER_ELEMENT_BYTES = 105;
/** Non-text inline node (hardBreak, wikilink…), stored as one embed item inside the text. */
export const PER_INLINE_NODE_BYTES = 36;
/** Each format mark is a pair of Yjs format items (start/end), about 54 each; a link also counts its attributes (`markBytes`). */
export const PER_MARK_BYTES = 55;
/** Corrections to {@link PER_ELEMENT_BYTES}: sub-list blockGroup overestimates ~1.2x, checklist item underestimates ~0.9x, table cells and their paragraphs overestimate ~1.15-1.2x. */
const ELEMENT_BYTES_BY_TYPE: Readonly<Record<string, number>> = { blockGroup: 20, checkListItem: 130, tableCell: 95, tableHeader: 95, tableParagraph: 95 };
const TABLE_CELL_BYTES = 2 * 95; // cell + paragraph in the cell (for the block-JSON estimate)
/** Link attributes besides href (key + default value); BlockNote's block JSON has only href. */
const LINK_DEFAULT_ATTR_BYTES = ("href" + "target" + "_blank" + "rel" + "noopener noreferrer nofollow").length; // all ASCII
/** Shorter string attributes (color, alignment, id) are already in each node's fixed cost. */
const LONG_ATTR_CHARS = 16;

const encoder = new TextEncoder();
export function utf8Bytes(s: string): number {
  return encoder.encode(s).byteLength;
}

/**
 * Re-measures a garbage-collected copy only above `remeasureAbove` (the size that would block or
 * warn): about 5x the cost of a raw encode and proportional to the whole doc.
 */
export function noteStateBytes(doc: Y.Doc, remeasureAbove?: number): number {
  const raw = Y.encodeStateAsUpdate(doc);
  if (remeasureAbove === undefined || raw.byteLength <= remeasureAbove) return raw.byteLength;
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, raw);
    return Y.encodeStateAsUpdate(copy).byteLength;
  } finally {
    copy.destroy();
  }
}

interface PmNodeLike {
  isText: boolean;
  type?: { name?: string };
  attrs?: Record<string, unknown>;
  isInline?: boolean;
  text?: string | null;
  marks: readonly { attrs?: Record<string, unknown> }[];
  forEach?: (f: (child: PmNodeLike) => void) => void;
  content?: { forEach(f: (child: PmNodeLike) => void): void };
}

function markBytes(marks: readonly { attrs?: Record<string, unknown> }[]): number {
  let n = 0;
  for (const m of marks) {
    n += PER_MARK_BYTES;
    if (m.attrs)
      for (const [k, v] of Object.entries(m.attrs)) {
        if (v === null || v === undefined) continue;
        n += utf8Bytes(k) + (typeof v === "string" ? utf8Bytes(v) : 0);
      }
  }
  return n;
}

function longAttrBytes(attrs: Record<string, unknown> | undefined): number {
  let n = 0;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (k !== "id" && typeof v === "string" && v.length > LONG_ATTR_CHARS) n += utf8Bytes(v);
  return n;
}

function pmNodeBytes(node: PmNodeLike): number {
  if (node.isText) return utf8Bytes(node.text ?? "") + markBytes(node.marks);
  let n = node.isInline ? PER_INLINE_NODE_BYTES + markBytes(node.marks) : (ELEMENT_BYTES_BY_TYPE[node.type?.name ?? ""] ?? PER_ELEMENT_BYTES);
  n += longAttrBytes(node.attrs);
  node.content?.forEach(child => (n += pmNodeBytes(child)));
  return n;
}

export function estimatePmBytes(sliceOrFragment: { content?: { forEach(f: (child: PmNodeLike) => void): void }; forEach?: (f: (child: PmNodeLike) => void) => void }): number {
  let n = 0;
  const each = sliceOrFragment.content?.forEach.bind(sliceOrFragment.content) ?? sliceOrFragment.forEach?.bind(sliceOrFragment);
  each?.((child: PmNodeLike) => (n += pmNodeBytes(child)));
  return n;
}

function textBytes(s: string): number {
  let breaks = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) breaks++;
  return utf8Bytes(s) + breaks * (PER_INLINE_NODE_BYTES - 1);
}

function inlineBytes(content: unknown, code = false): number {
  const text = code ? utf8Bytes : textBytes; // a newline in a code block is a plain \n in the text, not a line-break node
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text") {
      n += text(String(c.text ?? ""));
      const styles = c.styles as Record<string, unknown> | undefined;
      if (styles) for (const v of Object.values(styles)) n += PER_MARK_BYTES + (typeof v === "string" ? utf8Bytes(v) : 0);
    } else if (c.type === "link") {
      n += PER_MARK_BYTES + LINK_DEFAULT_ATTR_BYTES + utf8Bytes(String(c.href ?? "")) + inlineBytes(c.content, code);
    } else {
      n += PER_ELEMENT_BYTES + inlineBytes(c.content, code);
    }
  }
  return n;
}

export function estimateBlocksBytes(blocks: readonly unknown[]): number {
  let n = 0;
  for (const raw of blocks) {
    const b = raw as { type?: string; content?: unknown; children?: unknown[]; props?: Record<string, unknown> };
    n += PER_ELEMENT_BYTES + (ELEMENT_BYTES_BY_TYPE[b.type ?? ""] ?? PER_ELEMENT_BYTES); // blockContainer + content node
    n += longAttrBytes(b.props); // long attribute values (URLs, mermaid source)
    const content = b.content as { type?: string; rows?: Array<{ cells?: unknown[] }> } | unknown[] | string | undefined;
    if (content && !Array.isArray(content) && typeof content === "object" && content.type === "tableContent") {
      for (const row of content.rows ?? []) {
        n += PER_ELEMENT_BYTES;
        for (const cell of row.cells ?? []) {
          n += TABLE_CELL_BYTES;
          const c = cell as { content?: unknown } | unknown[];
          n += inlineBytes(Array.isArray(c) ? c : (c as { content?: unknown }).content);
        }
      }
    } else {
      n += inlineBytes(content, b.type === "codeBlock");
    }
    if (b.children && b.children.length > 0) n += (ELEMENT_BYTES_BY_TYPE.blockGroup ?? PER_ELEMENT_BYTES) + estimateBlocksBytes(b.children);
  }
  return n;
}

export function exceedsNoteLimit(doc: Y.Doc, growthBytes: number, limitBytes: number | undefined): boolean {
  if (limitBytes === undefined || growthBytes <= 0) return false;
  if (growthBytes > limitBytes) return true; // the growth alone exceeds the limit: no need to measure
  return noteStateBytes(doc, limitBytes - growthBytes) + growthBytes > limitBytes;
}

/** 1 MB = 1 048 576 bytes, so the default `NOTE_MAX_BYTES` of 5 MiB shows as 5 MB. */
export function formatNoteLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Number.isInteger(kb) ? kb : Math.max(kb, 0.1).toFixed(1)} KB`;
}

/**
 * Returned fn: true = over the limit, notify() already called, don't insert. Reads doc and limit
 * at call time: a closure fixed at editor creation must see current values.
 */
export function createNoteSizeGuard(getDoc: () => Y.Doc, getLimit: () => number | undefined, notify: (limitBytes: number) => void): (growthBytes: number) => boolean {
  return growthBytes => {
    const limit = getLimit();
    if (limit === undefined || !exceedsNoteLimit(getDoc(), growthBytes, limit)) return false;
    notify(limit);
    return true;
  };
}

interface PmViewLike {
  state: { selection: { empty: boolean; content(): { content?: { forEach(f: (child: PmNodeLike) => void): void } } } };
}

/**
 * Estimates after parsing and before inserting: every BlockNote paste path ends in
 * `handlePaste`, and drops go through `handleDrop`. An in-app drag move does not grow the note.
 */
export function createNoteSizePasteHandlers(guard: (growthBytes: number) => boolean): {
  handlePaste: (view: PmViewLike, event: ClipboardEvent, slice: Parameters<typeof estimatePmBytes>[0]) => boolean;
  handleDrop: (view: PmViewLike, event: DragEvent, slice: Parameters<typeof estimatePmBytes>[0], moved: boolean) => boolean;
} {
  return {
    handlePaste: (view, _event, slice) => {
      const sel = view.state.selection;
      const replaced = sel.empty ? 0 : estimatePmBytes(sel.content());
      return guard(estimatePmBytes(slice) - replaced);
    },
    handleDrop: (_view, _event, slice, moved) => (moved ? false : guard(estimatePmBytes(slice))),
  };
}
