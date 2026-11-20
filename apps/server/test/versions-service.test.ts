import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { clearVersionBase, createVersionService, setVersionBase, type VersionService } from "../src/collab/versions.js";
import { resetNoteVersionsInTx } from "../src/notes/tx/versions.js";
import { groups, noteVersions, notes, siteSettings, users } from "../src/db/schema.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { NO_PENDING, baseVersionIdOf, editPara, fakeHost, noteBase, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

const vfp = (d: Y.Doc) => versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));

const T0 = Date.parse("2026-10-14T00:00:00.000Z");

async function setup(opts: { group?: boolean; autoWaitMs?: number } = {}) {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const owner = opts.group ? { groupId: (await seedGroup(db, "G", [{ userId: u.id, role: "admin" }])).id } : { ownerId: u.id };
  const note = await seedNote(db, owner);
  const host = fakeHost();
  const warns: Array<{ obj: object; msg: string }> = [];
  let nowMs = T0;
  const svc: VersionService = createVersionService({
    db,
    log: { warn: (obj, msg) => warns.push({ obj, msg }) },
    now: () => new Date(nowMs),
    ...(opts.autoWaitMs !== undefined ? { autoWaitMs: opts.autoWaitMs } : {}),
  });
  svc.bind(host);
  /** Treat doc as "loaded": put it into the host and run noteLoaded. */
  const load = async (doc: Y.Doc) => {
    host.docs.set(note.id, doc);
    await svc.noteLoaded(note.id, doc);
  };
  const setNow = (ms: number) => {
    nowMs = ms;
  };
  return { db, u, note, host, warns, svc, load, setNow };
}

describe("noteLoaded", () => {
  it("loadFingerprint is grabbed synchronously before reading the DB: if the document changes during the await, loadFingerprint is still the one at call time", async () => {
    const s = await setup();
    const doc = paraDoc(["原文"]);
    const before = vfp(doc);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    editPara(doc, 0, t => t.insert(0, "改"));
    await p;
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: true, loadFingerprint: before, baseFingerprint: null, autoEnabled: true });
  });

  it("reads base, space key and auto-save switch: personal u:<owner>; group g:<group>; site off or space off -> autoEnabled false", async () => {
    const s = await setup();
    await s.db.update(notes).set({ versionBaseSeq: 3, versionBaseFingerprint: "abc" }).where(eq(notes.id, s.note.id));
    await s.load(paraDoc(["x"]));
    expect(s.svc.debugState(s.note.id)).toMatchObject({ baseFingerprint: "abc", spaceKey: `u:${s.u.id}`, autoEnabled: true });
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    s.svc.forget(s.note.id);
    await s.load(paraDoc(["x"]));
    expect(s.svc.debugState(s.note.id)!.autoEnabled).toBe(false);

    const g = await setup({ group: true });
    await g.load(paraDoc(["x"]));
    const [row] = await g.db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, g.note.id));
    expect(g.svc.debugState(g.note.id)!.spaceKey).toBe(`g:${row!.groupId}`);
    await g.db.update(siteSettings).set({ autoVersionsEnabled: false });
    g.svc.forget(g.note.id);
    await g.load(paraDoc(["x"]));
    expect(g.svc.debugState(g.note.id)!.autoEnabled).toBe(false);
    await g.db.update(siteSettings).set({ autoVersionsEnabled: true });
    await g.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, row!.groupId!));
    g.svc.forget(g.note.id);
    await g.load(paraDoc(["x"]));
    expect(g.svc.debugState(g.note.id)!.autoEnabled).toBe(false);
  });

  it("forgotten during the await when entered from onLoadDocument -> start over and initialize; in rerun mode it is discarded", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    s.svc.forget(s.note.id);
    await p;
    expect(s.svc.debugState(s.note.id)?.initialized).toBe(true);

    s.svc.forget(s.note.id);
    const r = s.svc.noteLoaded(s.note.id, doc, { rerun: true });
    s.svc.forget(s.note.id);
    await r;
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
  });

  it("when uninitialized noteChanged still records; initialization merges its result into the same entry (editors kept)", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await p;
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: true, editors: [{ userId: s.u.id, agentLabel: null }] });
  });

  it("note deleted: the entry is marked initialized but not auto-cutting (auto-disabled, no warn)", async () => {
    const s = await setup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    await s.load(paraDoc(["x"]));
    expect(await s.svc.cutIfDirty(s.note.id, s.host.docs.get(s.note.id)!, { kind: "auto" })).toEqual({ skipped: "auto-disabled" });
    expect(s.warns).toEqual([]);
  });
});

describe("noteChanged", () => {
  it("deduplicates by (userId, agentLabel), keeping first-appearance order", async () => {
    const s = await setup();
    await s.load(paraDoc(["x"]));
    const u2 = "00000000-0000-4000-8000-000000000002";
    for (const who of [
      { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: "Claude" }, { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: null },
    ]) s.svc.noteChanged(s.note.id, who);
    expect(s.svc.debugState(s.note.id)!.editors).toEqual([
      { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: "Claude" }, { userId: u2, agentLabel: null },
    ]);
  });
});

describe("cutIfDirty / isDirty", () => {
  it("uninitialized -> { skipped: uninitialized }, isDirty true (Map has an entry but noteLoaded has not finished)", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null }); // builds an initialized:false entry
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "uninitialized" });
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(true);
  });

  it("no base: unchanged -> null; type one character and delete it -> null; changed -> cut v1 (editors = pending list + extra) and state updated", async () => {
    const s = await setup();
    const doc = paraDoc(["舊內容"]);
    await s.load(doc);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    editPara(doc, 0, t => t.insert(0, "x"));
    editPara(doc, 0, t => t.delete(0, 1));
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(false);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    editPara(doc, 0, t => t.insert(0, "新"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto", extraEditors: [{ userId: s.u.id, agentLabel: "AI" }] });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, kind: "auto", baseSeq: null, editors: [{ user_id: s.u.id, agent_label: null }, { user_id: s.u.id, agent_label: "AI" }] } });
    expect(await noteBase(s.db, s.note.id)).toEqual({ counter: 1, baseSeq: 1, baseFingerprint: vfp(doc) });
    expect(s.svc.debugState(s.note.id)).toMatchObject({ baseFingerprint: vfp(doc), editors: [] });
    const [v1] = await versionsOf(s.db, s.note.id);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, v1!.ydoc);
    expect(vfp(restored)).toBe(vfp(doc));
  });

  it("no base and vacuum: auto does not cut; when loadFingerprint is null (after an apply reset) a non-vacuum document counts as changed", async () => {
    const s = await setup();
    const vacuum = new Y.Doc();
    await s.load(vacuum);
    expect(vfp(vacuum)).toBe(VACUUM_VERSION_FINGERPRINT);
    expect(await s.svc.cutIfDirty(s.note.id, vacuum, { kind: "auto" })).toBeNull();

    const t = await setup();
    const doc = paraDoc(["內容"]);
    await t.load(doc);
    t.svc.endApply(t.note.id, { reset: true });
    expect(t.svc.debugState(t.note.id)!.loadFingerprint).toBeNull();
    expect(await t.svc.isDirty(t.note.id, doc)).toBe(true);
    expect(await t.svc.cutIfDirty(t.note.id, doc, { kind: "auto" })).toMatchObject({ row: { seq: 1 } });
  });

  it("transient state (document not loaded): with no base never dirty and auto does not cut; manual still creates; not put in the Map", async () => {
    const s = await setup();
    const doc = paraDoc(["沒載入"]);
    expect(await s.svc.isDirty(s.note.id, doc, doc)).toBe(false);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto", transient: doc })).toBeNull();
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "里程碑", transient: doc })).toMatchObject({ upgraded: false, row: { seq: 1, kind: "manual", name: "里程碑" } });
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
    expect(await s.svc.isDirty(s.note.id, doc, doc)).toBe(false); // a base exists now, same as the base
  });

  it("four base_seq cases: first version null; base = latest -> null; base != latest (after applying an old version) -> filled with the base; then back to null", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const cut = async (text: string) => {
      editPara(doc, 0, t => t.insert(0, text));
      return s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    };
    expect(await cut("1")).toMatchObject({ row: { seq: 1, baseSeq: null } });
    expect(await cut("2")).toMatchObject({ row: { seq: 2, baseSeq: null } });
    const [v1] = await versionsOf(s.db, s.note.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc) }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) }); // simulates after applying v1 (content details are verified by other tests)
    expect(await cut("3")).toMatchObject({ row: { seq: 3, baseSeq: 1 } });
    expect(await cut("4")).toMatchObject({ row: { seq: 4, baseSeq: null } });
  });

  it("#272: a new row's base_version_id and base_seq are both filled or both NULL; notes.version_base_version_id follows cuts, setVersionBase, clearVersionBase and reset", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const cut = async (text: string) => {
      editPara(doc, 0, t => t.insert(0, text));
      return s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    };
    await cut("1");
    await cut("2");
    const [v1, v2] = await versionsOf(s.db, s.note.id);
    expect([v1!.baseVersionId, v2!.baseVersionId]).toEqual([null, null]);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v2!.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    expect(await setVersionBase(s.db, s.note.id, 1, vfp(v1doc), v1!.id)).toBe(true);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v1!.id);
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) }); // simulates after applying v1
    await cut("3");
    const v3 = (await versionsOf(s.db, s.note.id))[2]!;
    expect([v3.baseSeq, v3.baseVersionId]).toEqual([1, v1!.id]);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v3.id);
    // The base row no longer exists at cut time -> neither base_seq nor base_version_id is filled.
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc), versionBaseVersionId: v1!.id }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) });
    await s.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    await cut("4");
    const v4 = (await versionsOf(s.db, s.note.id)).at(-1)!;
    expect([v4.seq, v4.baseSeq, v4.baseVersionId]).toEqual([4, null, null]);
    await clearVersionBase(s.db, s.note.id);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBeNull();
    await s.db.update(notes).set({ versionBaseSeq: 4, versionBaseFingerprint: "x", versionBaseVersionId: v4.id }).where(eq(notes.id, s.note.id));
    await s.db.transaction(tx => resetNoteVersionsInTx(tx, { noteId: s.note.id }));
    expect(await baseVersionIdOf(s.db, s.note.id)).toBeNull();
  });

  it("the EXISTS in setVersionBase also compares id - after seq is reused (a different row with the same seq), a stale (seq, old versionId) does not set the base", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    const [v1, v2] = await versionsOf(s.db, s.note.id);
    const before = await baseVersionIdOf(s.db, s.note.id);
    expect(before).toBe(v2!.id);
    // Simulates seq=1 reused after a reset: the row with the same seq gets a new id.
    await s.db.update(noteVersions).set({ id: "00000000-0000-4000-8000-000000000001" }).where(eq(noteVersions.id, v1!.id));
    expect(await setVersionBase(s.db, s.note.id, 1, "fp", v1!.id)).toBe(false);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(before);
    expect(await setVersionBase(s.db, s.note.id, 1, "fp", "00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("cutting after deleting the latest non-base version - judged by the latest remaining, numbers are not reused", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    const [v1] = await versionsOf(s.db, s.note.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc) }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) });
    await s.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq in (2, 3)`);
    editPara(doc, 0, t => t.insert(0, "4"));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toMatchObject({ row: { seq: 4, baseSeq: null } });
  });

  it("base fingerprint or space key inside the transaction differs from memory -> null, no row created, state written back with the in-transaction values", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.db.update(notes).set({ versionBaseSeq: 9, versionBaseFingerprint: "other" }).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(s.svc.debugState(s.note.id)!.baseFingerprint).toBe("other");

    const g = await seedGroup(s.db, "H", [{ userId: s.u.id, role: "admin" }]);
    await s.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toBeNull();
    expect(s.svc.debugState(s.note.id)!.spaceKey).toBe(`g:${g.id}`);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("manual with content equal to the base -> upgraded:true, the base version becomes manual and gets the name, no new row; name null keeps the old name", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "定稿" })).toMatchObject({ upgraded: true, row: { seq: 1, kind: "manual", name: "定稿" } });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: null })).toMatchObject({ upgraded: true, row: { seq: 1, name: "定稿" } });
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
  });

  it("applying / auto-disabled block only auto; isDirty ignores applying", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.beginApply(s.note.id);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "applying" });
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(true);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toMatchObject({ row: { seq: 1 } });
    s.svc.endApply(s.note.id);
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    s.svc.forget(s.note.id);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "y"));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "auto-disabled" });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toMatchObject({ row: { seq: 2 } });
  });

  it("beginApply is recorded before loading: noteLoaded takes the value of applyingSet", async () => {
    const s = await setup();
    s.svc.beginApply(s.note.id);
    await s.load(paraDoc(["a"]));
    expect(s.svc.debugState(s.note.id)!.applying).toBe(true);
    s.svc.endApply(s.note.id);
    expect(s.svc.debugState(s.note.id)!.applying).toBe(false);
  });

  it("note deleted (both the transient and the Map state) -> { skipped: note-deleted }", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toEqual({ skipped: "note-deleted" });
    s.svc.forget(s.note.id);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", transient: doc })).toEqual({ skipped: "note-deleted" });
  });

  it("document loaded but no Map entry (the gap) -> uninitialized, even with transient given", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    s.host.docs.set(s.note.id, doc);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", transient: doc })).toEqual({ skipped: "uninitialized" });
  });
});

describe("relocated / forget", () => {
  it("relocated: a loaded note at once has an initialized:false entry and is initialized with the new space after noteLoaded reruns; one that is not loaded is only cleared", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    const g = await seedGroup(s.db, "H", [{ userId: s.u.id, role: "admin" }]);
    await s.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id));
    s.svc.relocated([s.note.id]);
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: false, editors: [] });
    await expect.poll(() => s.svc.debugState(s.note.id)?.initialized).toBe(true);
    expect(s.svc.debugState(s.note.id)!.spaceKey).toBe(`g:${g.id}`);
    s.host.docs.delete(s.note.id);
    s.svc.relocated([s.note.id]);
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
  });
});

describe("docFor / currentOf", () => {
  it("not loaded: reads note_states as a transient document; current carries baseSeq, nextSeq, dirty, autoEnabled (read from the DB)", async () => {
    const s = await setup();
    const stored = paraDoc(["DB 裡的"]);
    await seedDoc(s.db, s.note.id, stored);
    const { doc, transient } = await s.svc.docFor(s.note.id);
    expect(transient).toBe(doc);
    expect(vfp(doc)).toBe(vfp(stored));
    expect(await s.svc.currentOf(s.note.id)).toEqual({ baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true });
  });

  it("loaded: uses the live document; autoEnabled takes the value of this load cycle (a DB change does not affect it)", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    expect((await s.svc.docFor(s.note.id)).doc).toBe(doc);
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    expect(await s.svc.currentOf(s.note.id)).toEqual({ baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true });
    editPara(doc, 0, t => t.insert(0, "x"));
    expect((await s.svc.currentOf(s.note.id))!.dirty).toBe(true);
  });

  it("note does not exist -> currentOf null", async () => {
    const s = await setup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.svc.currentOf(s.note.id)).toBeNull();
  });
});

describe("pruneNote / sweep", () => {
  it("prune after a cut: deletes automatic versions by F/D, keeps manual, base and latest; one renamed to manual is not deleted", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3", "4"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    // Push v1-v3 to the same week 60 days ago; v2 is renamed to manual.
    await s.db.execute(sql`update note_versions set created_at = timestamptz '2026-08-01T10:00:00Z' + (seq || ' minutes')::interval where note_id = ${s.note.id} and seq <= 3`);
    await s.db.update(noteVersions).set({ kind: "manual", name: "留" }).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 2`);
    expect(await s.svc.pruneNote(s.note.id, new Date("2026-10-09T12:00:00Z"))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3, 4]); // v1 and v3 in the same week, v3 newer
  });

  it("sweep: the cursor continues, 0 rows in a round resets it (batch 100; the 250-note case is verified elsewhere)", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    await s.db.execute(sql`update note_versions set created_at = timestamptz '2026-08-01T10:00:00Z' + (seq || ' minutes')::interval where note_id = ${s.note.id} and seq <= 2`);
    const now = new Date("2026-10-09T12:00:00Z");
    expect(await s.svc.sweep(now)).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
    expect(await s.svc.sweep(now)).toBe(0); // cursor is after this note -> 0 rows -> cursor resets
    // After the reset the rescan: v2 is still "automatic and older than the cutoff", so this note is scanned again (a return of 1 = notes scanned, not rows deleted); v2 is the only candidate of its week, so it is not deleted.
    expect(await s.svc.sweep(now)).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
  });
});

describe("#272 pending writes (noteStored)", () => {
  const human = (userId: string) => ({ userId });
  const asJson = (userId: string, agentLabel: string | null = null) => ({ user_id: userId, agent_label: agentLabel });
  const direct = (source: "ai-edit" | "version-apply", userId: string, agentLabel: string | null, applied: boolean) =>
    ({ source, userId, tokenId: null, agentLabel, applied });

  it("human persist with a changed fingerprint -> version_pending_at = the injected now, editors = [human], ref = fingerprint at load, buffer cleared, nothing published", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const loaded = vfp(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual({ at: new Date(T0), editors: [asJson(s.u.id)], ref: loaded });
    expect(s.svc.debugState(s.note.id)).toMatchObject({ editors: [], lastStoredFingerprint: vfp(doc) });
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("persist again with the same fingerprint -> version_pending_at unchanged (zero DB)", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    s.setNow(T0 + 60_000);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("two persists by different editors -> first come first served, deduplicated; across forget + noteLoaded the same person is not repeated", async () => {
    const s = await setup();
    const u2 = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "1"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    editPara(doc, 0, t => t.insert(0, "2"));
    s.svc.noteChanged(s.note.id, { userId: u2.id, agentLabel: null });
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    s.setNow(T0 + 1000);
    await s.svc.noteStored(s.note.id, doc, human(u2.id));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id), asJson(u2.id)]);
    s.svc.forget(s.note.id);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "3"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    s.setNow(T0 + 2000);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toMatchObject({ at: new Date(T0 + 2000), editors: [asJson(s.u.id), asJson(u2.id)] });
  });

  it("ai-edit applied -> pending editors contain {userId, agentLabel}, nothing published; a persist by the same person with applied=false (the writer does not enter the list)", async () => {
    const s = await setup();
    const u2 = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "AI"));
    await s.svc.noteStored(s.note.id, doc, direct("ai-edit", s.u.id, "Claude", true));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id, "Claude")]);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    editPara(doc, 0, t => t.insert(0, "人"));
    s.svc.noteChanged(s.note.id, { userId: u2.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, direct("ai-edit", s.u.id, "被拒的", false));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id, "Claude"), asJson(u2.id)]);
  });

  it("version-apply applied -> pending cleared, post-apply content does not count as a change; a persist by the same person when rejected (applied=false)", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
    editPara(doc, 0, t => t.insert(0, "套"));
    await s.svc.noteStored(s.note.id, doc, direct("version-apply", s.u.id, null, true));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.lastStoredFingerprint).toBe(vfp(doc));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    editPara(doc, 0, t => t.insert(0, "y"));
    await s.svc.noteStored(s.note.id, doc, direct("version-apply", s.u.id, null, false));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("reset sub-case: after beginApply -> endApply(id, {reset}) and before the outer endApply(id), a due pending -> skipped: applying, 0 versions; cut only after the outer endApply(id)", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    s.svc.beginApply(s.note.id);
    s.svc.endApply(s.note.id, { reset: true });
    expect(s.svc.debugState(s.note.id)!.applying).toBe(true);
    expect(await s.svc.scanDue(new Date(T0 + 1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
    s.svc.endApply(s.note.id);
    expect(s.svc.debugState(s.note.id)!.applying).toBe(false);
    expect(await s.svc.scanDue(new Date(T0 + 2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("auto disabled -> not pending, buffer kept (left for manual save); uninitialized -> not pending", async () => {
    const s = await setup();
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.editors).toEqual([{ userId: s.u.id, agentLabel: null }]);

    const t = await setup();
    const d2 = paraDoc(["b"]);
    t.host.docs.set(t.note.id, d2);
    t.svc.noteChanged(t.note.id, { userId: t.u.id, agentLabel: null }); // builds an initialized:false entry
    editPara(d2, 0, x => x.insert(0, "y"));
    await t.svc.noteStored(t.note.id, d2, human(t.u.id));
    expect(await pendingOf(t.db, t.note.id)).toEqual(NO_PENDING);
  });

  it("markPending throws -> noteStored throws upward (server.ts swallows it and only warns), lastStoredFingerprint does not advance -> the next persist writes it again", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const loaded = vfp(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    const spy = vi.spyOn(s.db, "execute").mockRejectedValueOnce(new Error("pg 斷線（測試）"));
    await expect(s.svc.noteStored(s.note.id, doc, human(s.u.id))).rejects.toThrow("pg 斷線（測試）");
    spy.mockRestore();
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.lastStoredFingerprint).toBe(loaded);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("persist during the gap while relocated reruns -> the next persist counts as a change (lastStoredFingerprint is taken before the await)", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    s.svc.relocated([s.note.id]); // synchronous: forget + blank entry + rerun noteLoaded (the sync part already took `actual`)
    editPara(doc, 0, t => t.insert(0, "x")); // a change during the gap
    await s.svc.noteStored(s.note.id, doc, human(s.u.id)); // entry not initialized -> not written
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    await expect.poll(() => s.svc.debugState(s.note.id)?.initialized).toBe(true);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id)); // no new change, but the one during the gap was not recorded
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });
});
