import { createHash } from "node:crypto";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  AGENT_PRESENCE_COLOR, PRESENCE_FIELD, YDOC_FRAGMENT, sectionize, topLevelContainers,
  type AgentPresenceField, type EditOp,
} from "@knotebook/shared";
import type { CollabContext } from "../../collab/server.js";
import { SERVER_PRESENCE_ORIGIN } from "../../collab/awareness-sanitize.js";

// `clocks` is module-level and never pruned: the provider keeps meta clocks after removal (y-protocols awareness.js), so a restarted counter would be silently dropped and the AI would never reappear (guarded by "clock map is process lifetime" in editing-presence.test.ts).
// State must carry `beat`: awareness only emits change when state differs deeply, and the name tag only reads change.updated (@blocknote/core yjs.js).
// Re-read documents.get on every beat; never cache the Awareness (unload destroys it).
// The `knotebook` agent marker is how the web avatar list tells AI; origin is the one the collab server recognizes, so these client ids are registered as server-owned (#312).
const clocks = new Map<number, number>();
const ORIGIN = SERVER_PRESENCE_ORIGIN;
export const PRESENCE_COLOR = AGENT_PRESENCE_COLOR;

export interface PresenceIdentity { name: string; color: string; handle: string; label: string }

/** Single place that composes the display name; guarded only by two verbatim assertions (`note-presence.test.ts`, `mcp-content.test.ts`). */
export function presenceIdentity(userHandle: string, agentLabel: string): PresenceIdentity {
  return { name: `${userHandle} (${agentLabel})`, color: PRESENCE_COLOR, handle: userHandle, label: agentLabel };
}

export function presenceClientId(noteId: string, tokenId: string): number {
  return createHash("sha256").update(noteId + tokenId).digest().readUInt32BE(0);
}

export type PresenceTarget =
  | { kind: "section"; sectionId: string }
  | { kind: "block"; blockId: string }
  | { kind: "doc-start" };

export function presenceTargetForRead(section: string | undefined): PresenceTarget {
  return section === undefined ? { kind: "doc-start" } : { kind: "section", sectionId: section };
}

/**
 * Use only post-edit `afterBlockIds`, never the request's `section_id`: it is a heading id that replace_section/delete_section replace, so the lookup would silently fall back to doc start. `insert_after` deliberately lands on the first inserted block, not the heading.
 */
export function presenceTargetForWrite(op: EditOp, afterBlockIds: readonly string[]): PresenceTarget {
  if (op === "replace_all") return { kind: "doc-start" };
  const first = afterBlockIds[0];
  return first === undefined ? { kind: "doc-start" } : { kind: "block", blockId: first };
}

export interface PresenceOptions { now?: () => number; capacity?: number; idleMs?: number; heartbeatMs?: number }
interface Entry {
  noteId: string; tokenId: string; clientId: number;
  identity: PresenceIdentity; target: PresenceTarget; lastBeat: number;
  timer: ReturnType<typeof setInterval>; idle: ReturnType<typeof setTimeout>;
}

export class PresenceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly hocuspocus: Hocuspocus<CollabContext> | undefined;
  private readonly now: () => number;
  readonly capacity: number;
  private readonly idleMs: number;
  private readonly heartbeatMs: number;

  constructor(hocuspocus: Hocuspocus<CollabContext> | undefined, opts: PresenceOptions = {}) {
    this.hocuspocus = hocuspocus;
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity ?? 500;
    this.idleMs = opts.idleMs ?? 120_000;
    // The heartbeat may be shortened but never lengthened: the peer's y-protocols outdatedTimeout is a hard-coded 30 s.
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
  }
  get size(): number { return this.entries.size; }

  private bump(clientId: number): number {
    const n = (clocks.get(clientId) ?? 0) + 1;
    clocks.set(clientId, n);
    return n;
  }

  /** Must be the JSON form (`Y.relativePositionToJSON`), not the `Uint8Array` encoding: awareness JSON.stringify's it and y-prosemirror reads `createRelativePositionFromJSON`; the wrong shape throws "Unexpected case" client-side. */
  private cursorFor(doc: Y.Doc, target: PresenceTarget): { anchor: unknown; head: unknown } | null {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const containers = topLevelContainers(fragment);
    const byId = (id: string | undefined) => containers.find(c => c.getAttribute("id") === id);
    let block: Y.XmlElement | undefined = containers[0];
    if (target.kind === "section") {
      block = byId(sectionize(fragment).find(s => s.sectionId === target.sectionId)?.blockIds[0]) ?? block;
    } else if (target.kind === "block") {
      block = byId(target.blockId) ?? block;
    }
    if (block?.nodeName === "columnList") {
      const firstColumn = block.get(0);
      const first = firstColumn instanceof Y.XmlElement ? firstColumn.get(0) : undefined;
      block = first instanceof Y.XmlElement ? first : undefined;
    }
    // Both checks are needed: the first guards a doc with no top-level container yet (new note, nobody typed): `content` is undefined and `content.get(0)` would throw here; the second guards non-text first children (images; tables, where `get(0)` is a tableRow element), which would put a wrongly typed cursor into the awareness state.
    const content = block?.get(0);
    const text = content instanceof Y.XmlElement ? content.get(0) : undefined;
    if (!(text instanceof Y.XmlText)) return null;
    const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0));
    return { anchor: rel, head: rel };
  }

  private emit(entry: Entry, kind: "added" | "updated" | "removed"): void {
    const doc = this.hocuspocus?.documents.get(entry.noteId);
    if (!doc) return;
    const clock = this.bump(entry.clientId);
    if (kind === "removed") {
      doc.awareness.states.delete(entry.clientId);
    } else {
      const cursor = this.cursorFor(doc, entry.target);
      const { name, color, handle, label } = entry.identity;
      const knotebook: AgentPresenceField = { v: 1, kind: "agent", handle, label };
      doc.awareness.states.set(entry.clientId, { user: { name, color }, [PRESENCE_FIELD]: knotebook, beat: clock, ...(cursor ? { cursor } : {}) });
    }
    doc.awareness.meta.set(entry.clientId, { clock, lastUpdated: this.now() });
    doc.awareness.emit("update", [{
      added: kind === "added" ? [entry.clientId] : [],
      updated: kind === "updated" ? [entry.clientId] : [],
      removed: kind === "removed" ? [entry.clientId] : [],
    }, ORIGIN]);
  }

  touch(noteId: string, tokenId: string, identity: PresenceIdentity, target: PresenceTarget): void {
    if (!this.hocuspocus?.documents.get(noteId)) return;
    const key = `${noteId}:${tokenId}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.identity = identity; existing.target = target; existing.lastBeat = this.now();
      clearTimeout(existing.idle);
      existing.idle = setTimeout(() => this.stop(noteId, tokenId), this.idleMs);
      this.emit(existing, "updated");
      return;
    }
    if (this.entries.size >= this.capacity) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastBeat - b.lastBeat)[0]!;
      this.stop(oldest.noteId, oldest.tokenId);
    }
    const entry = { noteId, tokenId, clientId: presenceClientId(noteId, tokenId), identity, target, lastBeat: this.now() } as Entry;
    entry.timer = setInterval(() => { entry.lastBeat = this.now(); this.emit(entry, "updated"); }, this.heartbeatMs);
    entry.idle = setTimeout(() => this.stop(noteId, tokenId), this.idleMs);
    this.entries.set(key, entry);
    this.emit(entry, "added");
  }

  stop(noteId: string, tokenId: string): void {
    const entry = this.entries.get(`${noteId}:${tokenId}`);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.idle);
    this.entries.delete(`${noteId}:${tokenId}`);
    this.emit(entry, "removed");
  }

  stopAll(): void { for (const e of [...this.entries.values()]) this.stop(e.noteId, e.tokenId); }
}
