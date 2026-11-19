// Drives NoteWriteService directly (a separate instance with its own queue): the REST mapping is covered in the route tests.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { markPending } from "../src/collab/versions.js";
import { noteAiEdits, noteLinks, noteStates, noteVersions, notes } from "../src/db/schema.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { NoteWriteService } from "../src/notes/editing/write-service.js";
import { seedDoc } from "./copy-helpers.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime, type TestClient } from "./helpers.js";
import { NO_PENDING, baseVersionIdOf, noteBase, pendingOf, seedOldNote, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup() {
  let onMerge: (() => Promise<void>) | null = null;
  let onBase: (() => Promise<void>) | null = null;
  const hooks: EditingTestHooks = {
    beforeMerge: async () => { if (onMerge) await onMerge(); },
    beforeVersionBase: async () => { if (onBase) await onBase(); },
  };
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const writes = new NoteWriteService({ db: ctx.db, collab: ctx.collab, editing: testEditingRuntime, versions: ctx.collab.versions, testHooks: hooks });
  const log = ctx.app.log;
  const apply = (seq: number, versionId: string, discardUnsaved = false) =>
    writes.applyVersion(log, { noteId: note.id, seq, versionId, userId: u.id, discardUnsaved });
  const save = (name: string | null = null) => writes.saveVersion(log, { noteId: note.id, userId: u.id, name });
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const live = () => ctx.collab.hocuspocus.documents.get(note.id)!;
  const setHooks = (h: { merge?: (() => Promise<void>) | null; base?: (() => Promise<void>) | null }) => {
    if (h.merge !== undefined) onMerge = h.merge;
    if (h.base !== undefined) onBase = h.base;
  };
  return { ctx, u, note, session, writes, apply, save, unloaded, live, setHooks };
}
type S = Awaited<ReturnType<typeof setup>>;

async function setBlocks(s: S, client: TestClient, blocks: unknown[], sentinel: string): Promise<void> {
  const ed = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    ed.editor.replaceBlocks(ed.editor.document, blocks as never);
  } finally {
    ed.close();
  }
  await waitFor(`server 收到（${sentinel}）`, 5_000, () => docText(s.live()).includes(sentinel));
}
const ids = (d: Y.Doc) => topLevelContainers(d.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));

async function twoVersions(s: S) {
  const other = await s.ctx.createNote(s.u.id, "Other");
  const client = await s.session.connect(s.note.id);
  await setBlocks(s, client, [
    { type: "paragraph", content: [{ type: "text", text: "第一版 ", styles: {} }, { type: "wikilink", props: { targetNoteId: other.id, snapshotTitle: "Other" } }] },
  ], "第一版");
  const r1 = await s.save("一");
  await setBlocks(s, client, [{ type: "paragraph", content: "第二版內容" }], "第二版內容");
  const r2 = await s.save("二");
  if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
  return { client, other, v1: r1.row, v2: r2.row };
}

/** With no WS connection and the document not loaded: replaces note_states wholesale with content written out from markdown (server-side EditorSession, not via Hocuspocus). */
async function overwriteState(s: S, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const ed = await EditorSession.open(testEditingRuntime, doc);
  try {
    ed.editor.replaceBlocks(ed.editor.document, ed.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    ed.close();
  }
  await s.ctx.db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)) }).where(eq(noteStates.noteId, s.note.id));
}

async function storedText(s: S): Promise<string> {
  const [row] = await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row!.ydoc);
  return docText(doc);
}

describe("apply", () => {
  it("normal: content = snapshot (visible on another connection), block ids kept, base updated, dirty=false, no new version, no note_ai_edits written, attributed to the person, note_links updated", async () => {
    const s = await setup();
    const { client, other, v1 } = await twoVersions(s);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1.ydoc);
    const out = await s.apply(1, v1.id);
    expect(out).toEqual({ ok: true, result: { applied: true }, agentLabel: null });
    const second = await s.session.connect(s.note.id);
    await waitFor("第二條連線同步", 5_000, () => docText(second.doc).includes("第一版"));
    expect(docText(second.doc)).not.toContain("第二版內容");
    expect(ids(second.doc)).toEqual(ids(v1doc));
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false, nextSeq: 3 });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toEqual([]);
    const [stamp] = await s.ctx.db.select({ by: notes.lastEditedBy, label: notes.lastEditedAgentLabel, tokenId: notes.lastEditedTokenId }).from(notes).where(eq(notes.id, s.note.id));
    expect(stamp).toEqual({ by: s.u.id, label: null, tokenId: null });
    expect((await s.ctx.db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, s.note.id))).map(r => r.t)).toEqual([other.id]);
    client.disconnect();
    second.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2); // unload does not cut (#272)
  });

  it("apply, edit again, then cut -> the new version's base_seq = the applied version number ('continue from v1')", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    await s.apply(1, v1.id);
    await setBlocks(s, client, [{ type: "paragraph", content: "從一接著改" }], "從一接著改");
    const r = await s.save();
    expect(r).toMatchObject({ ok: true, upgraded: false, row: { seq: 3, baseSeq: 1 } });
    client.disconnect();
  });

  it("dirty and discardUnsaved=false -> version_unsaved_changes, content unchanged; discardUnsaved=true -> applies", async () => {
    const s = await setup();
    const { client, v1, v2 } = await twoVersions(s);
    await setBlocks(s, client, [{ type: "paragraph", content: "未存的修改" }], "未存的修改");
    // Priority: on a dirty document a mismatching versionId is still version_mismatch (the row is read before isDirty), not version_unsaved_changes.
    expect(await s.apply(1, v2.id)).toEqual({ ok: false, kind: "apply", code: "version_mismatch" });
    expect(await s.apply(1, v1.id)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(docText(s.live())).toContain("未存的修改");
    expect(await s.apply(1, v1.id, true)).toMatchObject({ ok: true });
    await waitFor("provider 收到套用", 5_000, () => docText(client.doc).includes("第一版"));
    client.disconnect();
  });

  it("someone edits text between fork and merge: discardUnsaved=true -> the first retry succeeds; two mismatches in a row -> 409 and content unchanged", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    let n = 0;
    s.setHooks({ merge: async () => {
      n += 1;
      if (n === 1) await setBlocks(s, client, [{ type: "paragraph", content: "插隊一" }], "插隊一");
    } });
    expect(await s.apply(1, v1.id, true)).toMatchObject({ ok: true });
    expect(n).toBe(2);
    expect(docText(s.live())).not.toContain("插隊一");
    expect(docText(s.live())).toContain("第一版");
    // The retry round's out is written back to the base: points at v1, not dirty after applying.
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false });

    s.setHooks({ merge: async () => {
      n += 1;
      await setBlocks(s, client, [{ type: "paragraph", content: `每次都插隊${n}` }], `每次都插隊${n}`);
    } });
    const before = n;
    expect(await s.apply(2, (await versionsOf(s.ctx.db, s.note.id))[1]!.id, true)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(n - before).toBe(2);
    expect(docText(s.live())).toContain(`每次都插隊${n}`);
    client.disconnect();
  });

  it("discardUnsaved=false and someone edits text after the fork -> the first retry's isDirty already gives 409 (merges only once)", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    const baseBefore = await noteBase(s.ctx.db, s.note.id);
    let n = 0;
    s.setHooks({ merge: async () => {
      n += 1;
      await setBlocks(s, client, [{ type: "paragraph", content: "插隊" }], "插隊");
    } });
    expect(await s.apply(1, v1.id)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(n).toBe(1);
    // Content was not applied (still the interleaved copy), base unchanged (still points at v2).
    expect(docText(s.live())).toContain("插隊");
    expect(docText(s.live())).not.toContain("第一版");
    expect(baseBefore.baseSeq).toBe(2);
    expect(await noteBase(s.ctx.db, s.note.id)).toEqual(baseBefore);
    client.disconnect();
  });

  it("versionId mismatch -> version_mismatch; seq does not exist -> not_found", async () => {
    const s = await setup();
    const { client, v2 } = await twoVersions(s);
    expect(await s.apply(1, v2.id)).toEqual({ ok: false, kind: "apply", code: "version_mismatch" });
    expect(await s.apply(99, v2.id)).toEqual({ ok: false, kind: "apply", code: "not_found" });
    client.disconnect();
  });

  it("beforeDisconnect fails -> content applied, base not updated, pending still cleared (#272), no version cut, applying cleared", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    client.disconnect();
    await s.unloaded(); // With no WS the apply's direct connection unloads on disconnect.
    await markPending(s.ctx.db, { noteId: s.note.id, at: new Date(Date.now() - 1000), add: [{ user_id: s.u.id, agent_label: null }], ref: null, spaceKey: `u:${s.u.id}` });
    s.setHooks({ base: async () => { throw new Error("基底寫回失敗（測試）"); } });
    expect(await s.apply(1, v1.id)).toMatchObject({ ok: true });
    await s.unloaded();
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(2);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.ctx.collab.versions.scanDue(new Date(Date.now() + 3_600_000));
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    const again = await s.session.connect(s.note.id);
    expect(docText(again.doc)).toContain("第一版");
    expect(s.ctx.collab.versions.debugState(s.note.id)?.applying).toBe(false);
    again.disconnect();
  });

  it("the version is deleted while queued -> base NULL (the 0-rows branch), content still applied", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    s.setHooks({ merge: async () => {
      await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    } });
    expect(await s.apply(1, v1.id)).toMatchObject({ ok: true });
    expect(await noteBase(s.ctx.db, s.note.id)).toMatchObject({ baseSeq: null, baseFingerprint: null });
    expect((await s.ctx.collab.versions.currentOf(s.note.id))!.baseSeq).toBeNull();
    client.disconnect();
  });

  it("a note nobody has open (old note, never had a WS) is applied -> version_base_seq = the applied version number, version count unchanged, unload cuts nothing, content persisted", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記第一版");
    const r1 = await s.save("一");
    await overwriteState(s, "舊筆記第二版");
    const r2 = await s.save("二");
    if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
    expect([r1.row.seq, r2.row.seq, (await noteBase(s.ctx.db, s.note.id)).baseSeq]).toEqual([1, 2, 2]);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    expect(await s.apply(1, r1.row.id)).toMatchObject({ ok: true });
    await s.unloaded();
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    const text = await storedText(s);
    expect(text).toContain("舊筆記第一版");
    expect(text).not.toContain("舊筆記第二版");
  });

  it("a note nobody has open, the version is deleted while queued -> base cleared (including uuid), pending cleared, unload cuts nothing (#272: the old order 'base write-back before disconnect' no longer affects versions)", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記第一版");
    const r1 = await s.save("一");
    await overwriteState(s, "舊筆記第二版");
    const r2 = await s.save("二");
    if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
    await markPending(s.ctx.db, { noteId: s.note.id, at: new Date(Date.now() - 1000), add: [{ user_id: s.u.id, agent_label: null }], ref: null, spaceKey: `u:${s.u.id}` });
    s.setHooks({ merge: async () => {
      await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    } });
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    expect(await s.apply(1, r1.row.id)).toMatchObject({ ok: true });
    await s.unloaded();
    expect((await versionsOf(s.ctx.db, s.note.id)).map(r => [r.seq, r.kind])).toEqual([[2, "manual"]]);
    expect(await noteBase(s.ctx.db, s.note.id)).toMatchObject({ baseSeq: null, baseFingerprint: null });
    expect(await baseVersionIdOf(s.ctx.db, s.note.id)).toBeNull();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.ctx.collab.versions.scanDue(new Date(Date.now() + 3_600_000));
    expect((await versionsOf(s.ctx.db, s.note.id)).map(r => [r.seq, r.kind])).toEqual([[2, "manual"]]);
    expect(await storedText(s)).toContain("舊筆記第一版");
  });

  it("after applying an empty version dirty=false (leaves one empty paragraph, fpAfter = vacuum fingerprint)", async () => {
    const s = await setup();
    const empty = await s.save("空");
    const client = await s.session.connect(s.note.id);
    await setBlocks(s, client, [{ type: "paragraph", content: "後來的內容" }], "後來的內容");
    await s.save();
    if (!empty.ok) throw new Error("前置失敗");
    expect(await s.apply(1, empty.row.id)).toMatchObject({ ok: true });
    expect(topLevelContainers(s.live().getXmlFragment(YDOC_FRAGMENT))).toHaveLength(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false });
    client.disconnect();
  });
});

describe("manual save (service half)", () => {
  it("clean with a base -> upgraded, total unchanged; dirty -> new version; an old note with no base (not loaded) -> creates a version; note deleted -> note-deleted", async () => {
    const s = await setup();
    const old = new Y.Doc();
    const ed = await EditorSession.open(testEditingRuntime, old);
    try {
      ed.editor.replaceBlocks(ed.editor.document, ed.editor.tryParseMarkdownToBlocks("舊筆記"));
    } finally {
      ed.close();
    }
    await seedDoc(s.ctx.db, s.note.id, old);
    expect(await s.save("首存")).toMatchObject({ ok: true, upgraded: false, row: { seq: 1, kind: "manual", name: "首存" } });
    expect(await s.save("改名")).toMatchObject({ ok: true, upgraded: true, row: { seq: 1, name: "改名" } });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    const client = await seedContent(s.ctx, s.session, s.note.id, "新增的一段文字");
    expect(await s.save()).toMatchObject({ ok: true, upgraded: false, row: { seq: 2 } });
    client.disconnect();
    await s.unloaded();
    await s.ctx.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.save()).toEqual({ ok: false, kind: "note-deleted" });
  });
});
