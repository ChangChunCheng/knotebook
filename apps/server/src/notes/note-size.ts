/**
 * Judged on the result of a trial apply on a new doc, not on the structure an update claims (inferring added/deleted from structure is whack-a-mole: duplicate delete ranges, deleted map keys, subdoc meta, XmlHook names, BigInt in ContentAny). Rejects iff stateAfter > cap and stateAfter > stateBefore and (liveAfter > liveBefore or growth > SLACK): deletions and same-size rewrites on an over-cap note are accepted, state-only growth (set a huge key, delete it) is not.
 * Browser collab updates aren't checked on the server: the web editor guards paste/drop/in-site AI itself (`apps/web/src/lib/note-size-guard.ts`). Notes already over the limit still open, read and export.
 */
import * as Y from "yjs";
import { SITE_LIMITS } from "@knotebook/shared";

export const DEFAULT_NOTE_MAX_BYTES = SITE_LIMITS.noteMaxBytes.default;
/** pg `bytea` limit (1 GiB). */
export const NOTE_MAX_BYTES_MAX = 1024 * 1024 * 1024;

const WS_DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;

/** The web's size guard doesn't cover undo and moves, so message size ≈ 2× the largest configurable cap + 1 MiB. Bigger notes can exceed it on a single undo/move and the connection is closed. Never above ws's 100 MiB default. */
export function collabMaxPayloadBytes(envNoteMaxBytes: number | undefined): number {
  return Math.min(2 * (envNoteMaxBytes ?? SITE_LIMITS.noteMaxBytes.max) + 1_048_576, WS_DEFAULT_MAX_PAYLOAD);
}

/** Normal deletions/rewrites leave tens of bytes of bookkeeping (a mid-text delete ~1.9× the update; a same-size rewrite ~43 B); 4 KiB bounds bookkeeping-only growth tricks per message. */
export const SIZE_SLACK_BYTES = 4 * 1024;

export function growsPastCap(before: number, after: number, cap: number): boolean {
  return after > cap && after > before;
}

export interface SizeMeasure {
  stateBefore: number;
  stateAfter: number;
  liveBefore: number;
  liveAfter: number;
}

export function capBlocks(m: SizeMeasure, cap: number): boolean {
  return m.stateAfter > cap && m.stateAfter > m.stateBefore && (m.liveAfter > m.liveBefore || m.stateAfter - m.stateBefore > SIZE_SLACK_BYTES);
}

export class NoteTooLargeError extends Error {
  override name = "NoteTooLargeError";
  constructor(
    readonly limitBytes: number,
    readonly sizeBytes: number
  ) {
    super(`note would grow to ${sizeBytes} bytes, over the ${limitBytes}-byte limit`);
  }
}

export function noteTooLargeMessage(limitBytes: number): string {
  return `This change would make the note larger than the site's limit of ${limitBytes} bytes, so nothing was written. Deleting and shortening are still accepted; to add more, split the note.`;
}

export function stateSize(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
function varUintLength(n: number): number {
  let len = 1;
  while (n > 127) {
    n = Math.floor(n / 128);
    len++;
  }
  return len;
}
/** Text and array values don't count each item's length prefix: editing mid-text splits one item into three, and the extra prefixes aren't new content (a same-size rewrite would look like growth). */
export function liveContentBytes(doc: Y.Doc): number {
  const enc = new Y.UpdateEncoderV1();
  let direct = 0;
  for (const structs of doc.store.clients.values()) {
    for (const st of structs) {
      if (!(st instanceof Y.Item) || st.deleted) continue;
      const c = st.content;
      if (c instanceof Y.ContentString) direct += utf8Length(c.str);
      else {
        c.write(enc, 0);
        if (c instanceof Y.ContentAny || c instanceof Y.ContentJSON) direct -= varUintLength(c.getLength());
      }
      if (st.parentSub !== null) direct += utf8Length(st.parentSub);
    }
  }
  return enc.toUint8Array().byteLength + direct;
}

export function measureTrial(state: Uint8Array, update: Uint8Array): SizeMeasure {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state);
  const stateBefore = stateSize(doc);
  const liveBefore = liveContentBytes(doc);
  Y.applyUpdate(doc, update);
  return { stateBefore, stateAfter: stateSize(doc), liveBefore, liveAfter: liveContentBytes(doc) };
}
