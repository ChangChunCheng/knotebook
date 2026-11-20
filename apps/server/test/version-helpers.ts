// Documents are hand-built in BlockNote shape (blockGroup > blockContainer(id) > paragraph > XmlText) without mounting the editor - the version service reads only the Yjs structure,
// so how it is built is irrelevant to the content fingerprint. Exception: `seedOldNote` simulates "an old note written by a browser" and goes through EditorSession.
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteVersions, notes } from "../src/db/schema.js";
import type { VersionDocsHost } from "../src/collab/versions.js";
import type { NoteVersionRow, VersionEditorJson } from "../src/notes/tx/versions.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { seedDoc } from "./copy-helpers.js";
import { testEditingRuntime } from "./helpers.js";

export function paraDoc(texts: string[]): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  const pending: Array<[Y.XmlText, string]> = [];
  g.insert(0, texts.map(text => {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", randomUUID());
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    c.insert(0, [p]);
    pending.push([t, text]);
    return c;
  }));
  for (const [t, s] of pending) if (s) t.insert(0, s);
  return doc;
}

/** 5000 nested levels (each blockContainer > [paragraph, blockGroup]): `canonicalizeNode`'s recursion throws RangeError at this depth. */
export function deepDoc(depth: number): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  let parent: Y.XmlElement = g;
  for (let i = 0; i < depth; i += 1) {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", `d${i}`);
    const inner = new Y.XmlElement("blockGroup");
    c.insert(0, [new Y.XmlElement("paragraph"), inner]);
    parent.insert(0, [c]);
    parent = inner;
  }
  return doc;
}

export function editPara(doc: Y.Doc, i: number, fn: (t: Y.XmlText) => void): void {
  const p = topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))[i]!.get(0) as Y.XmlElement;
  doc.transact(() => fn(p.get(0) as Y.XmlText));
}

export async function versionsOf(db: Db, noteId: string): Promise<NoteVersionRow[]> {
  return db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(asc(noteVersions.seq));
}

export async function waitForVersionCount(db: Db, noteId: string, n: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await versionsOf(db, noteId)).length;
    if (last === n) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`等待逾時（${ms}ms）：note_versions 列數 ${last}，期望 ${n}`);
}

export async function noteBase(db: Db, noteId: string): Promise<{ counter: number; baseSeq: number | null; baseFingerprint: string | null }> {
  const [r] = await db
    .select({ counter: notes.versionCounter, baseSeq: notes.versionBaseSeq, baseFingerprint: notes.versionBaseFingerprint })
    .from(notes)
    .where(eq(notes.id, noteId));
  return r!;
}

export interface Pending {
  at: Date | null;
  editors: VersionEditorJson[];
  ref: string | null;
}
export const NO_PENDING: Pending = { at: null, editors: [], ref: null };

export async function pendingOf(db: Db, noteId: string): Promise<Pending> {
  const [r] = await db
    .select({ at: notes.versionPendingAt, editors: notes.versionPendingEditors, ref: notes.versionPendingRefFingerprint })
    .from(notes)
    .where(eq(notes.id, noteId));
  return r!;
}

export async function baseVersionIdOf(db: Db, noteId: string): Promise<string | null> {
  const [r] = await db.select({ id: notes.versionBaseVersionId }).from(notes).where(eq(notes.id, noteId));
  return r!.id;
}

/** Waits until the note's pending cut satisfies `pred` (default: has pending). `noteStored` writes only after the 2 s persist debounce, so after a WS edit this must be awaited. */
export async function waitForPending(db: Db, noteId: string, pred: (p: Pending) => boolean = p => p.at !== null, ms = 10_000): Promise<Pending> {
  const deadline = Date.now() + ms;
  let last: Pending | null = null;
  while (Date.now() < deadline) {
    last = await pendingOf(db, noteId);
    if (pred(last)) return last;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`等待逾時（${ms}ms）：待切 ${JSON.stringify(last)}`);
}

/** An "old note": existed before the feature shipped, `note_states` has content, no versions at all (written as markdown by the server-side EditorSession, then inserted directly into `note_states`). */
export async function seedOldNote(db: Db, noteId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    s.close();
  }
  await seedDoc(db, noteId, doc);
}

export function fakeHost(): VersionDocsHost & { docs: Map<string, Y.Doc> } {
  const docs = new Map<string, Y.Doc>();
  return { docs, documents: { get: name => docs.get(name), has: name => docs.has(name) } };
}
