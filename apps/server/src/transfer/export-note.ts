/**
 * No DB I/O while the lease is held (`titles` are looked up by the caller before mounting).
 * Yields hold the lease without acquiring, which is safe: acquire isn't re-entrant, and live
 * doc edits during a yield don't affect this fork. Group exports run inside the same mount.
 */
import type * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import { topLevelFingerprints } from "../notes/editing/fingerprint.js";
import { toNoteMarkdown } from "../notes/editing/read.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { EditorSession } from "../notes/editing/session.js";
import { alignSegments, lineKindsOf, type AlignStats } from "./align.js";
import { labelFreeLinkTexts } from "./link-texts.js";
import { bodyLines, normalizeBody } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

export interface ExportedNote {
  body: string;
  lines: string[];
  ids: string[];
  fps: string[];
  types: string[];
  /** null = can't be written back. */
  segments: TransferSegment[] | null;
  lineKinds: number[];
  stats: AlignStats & { yields: number };
}

export interface ExportNoteOptions {
  yieldEveryBlocks?: number;
  yieldAfterMs?: number;
  yieldFn?: () => Promise<void>;
  forceUnmergeable?: boolean;
  linkHash?: (targetId: string, text: string) => string;
}

/** Must build `body` exactly like `exportNoteForTransfer` (pinned byte-for-byte in `transfer-write-reread.test.ts`). */
export async function exportNoteBody(runtime: EditingRuntime, doc: Y.Doc, titles: ReadonlyMap<string, string>): Promise<string> {
  // Don't mount an empty doc: mounting normalizes it into one empty paragraph, which would mismatch the ids.
  if (topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).length === 0) return "";
  const s = await EditorSession.open(runtime, doc);
  try {
    return toNoteMarkdown(s.editor, s.editor.document, titles);
  } finally {
    s.close();
  }
}

const DEFAULT_YIELD_EVERY_BLOCKS = 50;
const DEFAULT_YIELD_AFTER_MS = YIELD_AFTER_MS;

export async function exportNoteForTransfer(
  runtime: EditingRuntime,
  doc: Y.Doc,
  titles: ReadonlyMap<string, string>,
  opts: ExportNoteOptions = {},
): Promise<ExportedNote> {
  const yieldEvery = opts.yieldEveryBlocks ?? DEFAULT_YIELD_EVERY_BLOCKS;
  const yieldAfterMs = opts.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS;
  const yieldFn = opts.yieldFn ?? yieldToLoop;

  const { ids, fps } = topLevelFingerprints(doc.getXmlFragment(YDOC_FRAGMENT));
  // Don't mount an empty doc: mounting normalizes it into one empty paragraph, which would mismatch the ids.
  if (ids.length === 0) {
    return { body: "", lines: [], ids, fps, types: [], segments: [], lineKinds: [], stats: { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0, yields: 0 } };
  }

  const s = await EditorSession.open(runtime, doc);
  try {
    // The big stalls are the mount and the whole-note export; yield after each.
    let yields = 0;
    await yieldFn();
    yields++;
    const top = s.editor.document;
    const body = toNoteMarkdown(s.editor, top, titles);
    await yieldFn();
    yields++;
    const lines = bodyLines(normalizeBody(body));
    const types = top.map(b => b.type as string);
    // Mount changed top-level ids (e.g. BlockNote renames duplicate ids): the segment table no longer matches, so degrade to not writable back.
    if (top.length !== ids.length || top.some((b, i) => b.id !== ids[i])) {
      return { body, lines, ids, fps, types, segments: null, lineKinds: lineKindsOf(null, types, lines.length), stats: { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0, yields } };
    }

    const per: string[][] = [];
    let last = performance.now();
    for (let i = 0; i < top.length; i++) {
      per.push(bodyLines(normalizeBody(toNoteMarkdown(s.editor, [top[i]!], titles))));
      if ((i + 1) % yieldEvery === 0 || performance.now() - last >= yieldAfterMs) {
        await yieldFn();
        yields++;
        last = performance.now();
      }
    }

    const { segs, stats } = alignSegments(lines, per, types, (i, j) => bodyLines(normalizeBody(toNoteMarkdown(s.editor, top.slice(i, j + 1), titles))));
    const aligned = opts.forceUnmergeable ? null : segs;
    const linkHash = opts.linkHash;
    const segments: TransferSegment[] | null = aligned === null ? null : aligned.map(sg => {
      const seg: TransferSegment = { ids: sg.idx.map(k => ids[k]!), fps: sg.idx.map(k => fps[k]!), start: sg.start, count: sg.count };
      if (linkHash) {
        const links = [...new Set(labelFreeLinkTexts(sg.idx.map(k => top[k]!), titles).map(([id, text]) => linkHash(id, text)))];
        if (links.length > 0) seg.links = links;
      }
      return seg;
    });
    return { body, lines, ids, fps, types, segments, lineKinds: lineKindsOf(aligned, types, lines.length), stats: { ...stats, yields } };
  } finally {
    s.close();
  }
}
