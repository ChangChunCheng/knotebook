// The service is built directly (fakeHost, no Hocuspocus), so pending is always written with `markPending` rather than through noteStored.
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import {
  VERSION_AUTO_SCAN_BACKOFF_MS, VERSION_AUTO_SCAN_BATCH, clearPendingIfDue, createVersionService, markPending,
  type VersionService, type VersionServiceDeps,
} from "../src/collab/versions.js";
import { groups, notes, siteSettings } from "../src/db/schema.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { NO_PENDING, editPara, fakeHost, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

// "Fingerprint cannot be computed": the version fingerprint itself deliberately never throws (see the header of `version-fingerprint.ts`), so it throws only for documents
// containing the sentinel string; other documents are computed by the real implementation (including this file's `vfp`).
vi.mock("../src/notes/version-fingerprint.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/notes/version-fingerprint.js")>();
  return {
    ...real,
    versionFingerprint: (f: Y.XmlFragment) => {
      if (f.toString().includes("指紋炸彈")) throw new Error("指紋炸彈（測試）");
      return real.versionFingerprint(f);
    },
  };
});

const vfp = (d: Y.Doc) => versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(T0 + ms);

async function setup(deps: Partial<VersionServiceDeps> = {}) {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const note = await seedNote(db, { ownerId: u.id });
  const host = fakeHost();
  const warns: Array<{ obj: object; msg: string }> = [];
  const mk = (extra: Partial<VersionServiceDeps> = {}): VersionService => {
    const svc = createVersionService({ db, log: { warn: (obj, msg) => warns.push({ obj, msg }) }, ...deps, ...extra });
    svc.bind(host);
    return svc;
  };
  const svc = mk();
  const space = `u:${u.id}`;
  const me = { user_id: u.id, agent_label: null };
  /** Note not loaded: sets note_states to this content (the scanner reads it via `docFor`). Call once per note (seedDoc is an INSERT). */
  const store = async (noteId: string, texts: string[]) => {
    const d = paraDoc(texts);
    await seedDoc(db, noteId, d);
    return d;
  };
  const pend = (noteId: string, when: Date, who: Array<{ user_id: string; agent_label: string | null }> = [me], ref: string | null = null, sp = space) =>
    markPending(db, { noteId, at: when, add: who, ref, spaceKey: sp });
  const warnsWith = (needle: string) => warns.filter(w => w.msg.includes(needle)).length;
  return { db, u, note, host, warns, warnsWith, svc, mk, space, me, store, pend };
}

describe("markPending / clearPendingIfDue", () => {
  it("with no base ref is written only when pending starts and not overwritten within the same span; cleared and restarted -> replaced; with a base ref is always NULL; editors first come first served, deduplicated", async () => {
    const s = await setup();
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    expect(await s.pend(s.note.id, at(0), [s.me], "ref-1")).toBe(1);
    expect(await s.pend(s.note.id, at(1000), [claude, s.me], "ref-2")).toBe(1);
    expect(await pendingOf(s.db, s.note.id)).toEqual({ at: at(1000), editors: [s.me, claude], ref: "ref-1" });
    expect(await clearPendingIfDue(s.db, s.note.id, at(1000))).toBe(1);
    await s.pend(s.note.id, at(2000), [s.me], "ref-3");
    expect((await pendingOf(s.db, s.note.id)).ref).toBe("ref-3");
    const based = await seedNote(s.db, { ownerId: s.u.id });
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: "fp" }).where(eq(notes.id, based.id));
    await s.pend(based.id, at(0), [s.me], "ref-x");
    expect((await pendingOf(s.db, based.id)).ref).toBeNull();
  });

  it("clearPendingIfDue clears only the span that is still due, not a newer one", async () => {
    const s = await setup();
    await s.pend(s.note.id, at(5 * MIN));
    expect(await clearPendingIfDue(s.db, s.note.id, at(5 * MIN - 1))).toBe(0);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(5 * MIN));
    expect(await clearPendingIfDue(s.db, s.note.id, at(5 * MIN))).toBe(1);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("space predicate: space key does not match (an old persist landing after a move/transfer) -> 0 rows; not of the u:/g: shape -> 0 rows", async () => {
    const s = await setup();
    const g = await seedGroup(s.db, "G", [{ userId: s.u.id, role: "admin" }]);
    expect(await s.pend(s.note.id, at(0), [s.me], null, `g:${g.id}`)).toBe(0);
    expect(await s.pend(s.note.id, at(0), [s.me], null, "")).toBe(0);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(await s.pend(s.note.id, at(0))).toBe(1);
  });

  it("agent name containing double quotes, backslash, emoji, CJK; the same person with different agents -> deduplicated verbatim; the cut version's editors matches the list", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const list = [`Cl"aude \\ 🤖`, "助手（測試）", "a'b"].map(l => ({ user_id: s.u.id, agent_label: l }));
    await s.store(s.note.id, ["特殊字元名單"]);
    await s.pend(s.note.id, at(0), [list[0]!, list[1]!, list[0]!], VACUUM_VERSION_FINGERPRINT);
    await s.pend(s.note.id, at(1), [list[1]!, s.me, list[2]!]);
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([list[0], list[1], s.me, list[2]]);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.editors)).toEqual([[list[0], list[1], s.me, list[2]]]);
  });
});

describe("scanner scanDue", () => {
  it("not due -> no cut; due and dirty -> 1 version, editors = pending editors, pending cleared in the same transaction", async () => {
    const s = await setup({ autoWaitMs: 5 * MIN });
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    await s.store(s.note.id, ["掃描切的內容"]);
    await s.pend(s.note.id, at(0), [s.me, claude], VACUUM_VERSION_FINGERPRINT);
    expect(await s.svc.scanDue(at(5 * MIN - 1))).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(await s.svc.scanDue(at(5 * MIN))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => [v.seq, v.kind, v.editors])).toEqual([[1, "auto", [s.me, claude]]]);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("changed and changed back (content = reference fingerprint) -> 0 versions, pending cleared", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const d = await s.store(s.note.id, ["原文"]);
    await s.pend(s.note.id, at(0), [s.me], vfp(d));
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("a new persist after the scan query but before the transaction (afterMetaRead) -> not-due, 0 versions, the new pending kept; once the new span is due it is cut as usual", async () => {
    let inserted = false;
    const s = await setup();
    const svc = s.mk({
      autoWaitMs: 0,
      testHooks: {
        afterMetaRead: async id => {
          if (inserted) return;
          inserted = true;
          await markPending(s.db, { noteId: id, at: at(10 * MIN), add: [s.me], ref: null, spaceKey: s.space });
        },
      },
    });
    await s.store(s.note.id, ["內容"]);
    await s.pend(s.note.id, at(0));
    expect(await svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(10 * MIN));
    expect(await svc.scanDue(at(10 * MIN))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("applying -> kept (cut after apply ends); auto disabled -> cleared, 0 versions; fingerprint cannot be computed -> cleared + warn; note deleted -> skipped, no warn", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["套用中"]);
    await s.pend(s.note.id, at(0));
    s.svc.beginApply(s.note.id);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    s.svc.endApply(s.note.id);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);

    const g = await seedGroup(s.db, "關", [{ userId: s.u.id, role: "admin" }]);
    const off = await seedNote(s.db, { groupId: g.id });
    await s.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, g.id));
    await s.store(off.id, ["空間關了"]);
    await s.pend(off.id, at(0), [s.me], null, `g:${g.id}`);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, off.id)).toEqual([]);
    expect(await pendingOf(s.db, off.id)).toEqual(NO_PENDING);

    const bomb = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(bomb.id, ["指紋炸彈"]);
    await s.pend(bomb.id, at(0));
    expect(await s.svc.scanDue(at(4))).toBe(1);
    expect(await versionsOf(s.db, bomb.id)).toEqual([]);
    expect(await pendingOf(s.db, bomb.id)).toEqual(NO_PENDING);
    expect(s.warnsWith("版本指紋算不出來")).toBe(1);

    const gone = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(gone.id, ["會被刪"]);
    await s.pend(gone.id, at(0));
    const svc = s.mk({ autoWaitMs: 0, testHooks: { beforeCutDue: async id => { await s.db.delete(notes).where(eq(notes.id, id)); } } });
    const before = s.warns.length;
    expect(await svc.scanDue(at(5))).toBe(1);
    expect(await versionsOf(s.db, gone.id)).toEqual([]);
    expect(s.warns.length).toBe(before);
  });

  it("loaded and not loaded are both cut; a new service instance (simulated restart, memory empty) cuts as usual", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const live = paraDoc(["載入中"]);
    s.host.docs.set(s.note.id, live);
    await s.svc.noteLoaded(s.note.id, live);
    const loaded = vfp(live);
    editPara(live, 0, t => t.insert(0, "改"));
    await s.pend(s.note.id, at(0), [s.me], loaded);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    const [v] = await versionsOf(s.db, s.note.id);
    const snap = new Y.Doc();
    Y.applyUpdate(snap, v!.ydoc);
    expect(vfp(snap)).toBe(vfp(live));

    const cold = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(cold.id, ["沒載入"]);
    await s.pend(cold.id, at(0));
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, cold.id)).toHaveLength(1);

    const later = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(later.id, ["重啟後"]);
    await s.pend(later.id, at(0));
    const restarted = s.mk({ autoWaitMs: 0 });
    expect(await restarted.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, later.id)).toHaveLength(1);
  });

  it("X is read from the site's current value at scan time (a change acts at once on already-pending notes); no site_settings row -> default 5 minutes; deps.autoWaitMs overrides the DB; overrideAutoWaitMs takes priority over that", async () => {
    const s = await setup();
    await s.store(s.note.id, ["等多久"]);
    await s.pend(s.note.id, at(0));
    expect(await s.svc.scanDue(at(3 * MIN))).toBe(0);
    await s.db.update(siteSettings).set({ versionAutoWaitMinutes: 2 });
    expect(await s.svc.scanDue(at(3 * MIN))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);

    const n2 = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(n2.id, ["deps 覆寫"]);
    await s.pend(n2.id, at(0));
    const svc = s.mk({ autoWaitMs: 10 * MIN });
    expect(await svc.scanDue(at(3 * MIN))).toBe(0);
    svc.overrideAutoWaitMs(1000);
    expect(await svc.scanDue(at(3 * MIN))).toBe(1);
    expect(await versionsOf(s.db, n2.id)).toHaveLength(1);
    svc.overrideAutoWaitMs(null);

    const n3 = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(n3.id, ["沒有站台設定列"]);
    await s.pend(n3.id, at(0));
    await s.db.delete(siteSettings);
    expect(await s.svc.scanDue(at(5 * MIN - 1))).toBe(0);
    expect(await s.svc.scanDue(at(5 * MIN))).toBe(1);
    expect(await versionsOf(s.db, n3.id)).toHaveLength(1);
  });

  it("at most 100 notes per round, oldest first; two concurrent scanDue calls -> the second returns 0; stopScan stops between notes, the remaining pending is kept, and it returns 0 afterwards", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const ids: string[] = [];
    for (let i = 0; i <= VERSION_AUTO_SCAN_BATCH; i += 1) {
      const n = await seedNote(s.db, { ownerId: s.u.id });
      await s.store(n.id, [`第 ${i} 篇`]);
      await s.pend(n.id, at(i * 1000));
      ids.push(n.id);
    }
    const [first, second] = await Promise.all([s.svc.scanDue(at(HOUR)), s.svc.scanDue(at(HOUR))]);
    expect([first, second]).toEqual([VERSION_AUTO_SCAN_BATCH, 0]);
    expect(await versionsOf(s.db, ids[0]!)).toHaveLength(1);
    expect(await versionsOf(s.db, ids[VERSION_AUTO_SCAN_BATCH]!)).toEqual([]);
    expect((await pendingOf(s.db, ids[VERSION_AUTO_SCAN_BATCH]!)).at).toEqual(at(VERSION_AUTO_SCAN_BATCH * 1000));
    expect(await s.svc.scanDue(at(HOUR))).toBe(1);

    const t = await setup({ autoWaitMs: 0 });
    const three: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedNote(t.db, { ownerId: t.u.id });
      await t.store(n.id, [`停 ${i}`]);
      await t.pend(n.id, at(i * 1000));
      three.push(n.id);
    }
    const holder: { svc?: VersionService } = {};
    holder.svc = t.mk({ testHooks: { beforeCutDue: async () => { void holder.svc!.stopScan(); } } });
    expect(await holder.svc.scanDue(at(HOUR))).toBe(3);
    const counts = await Promise.all(three.map(async id => (await versionsOf(t.db, id)).length));
    expect(counts).toEqual([1, 0, 0]);
    expect((await pendingOf(t.db, three[1]!)).at).toEqual(at(1000));
    expect(await holder.svc.scanDue(at(HOUR))).toBe(0);
    await expect(holder.svc.stopScan()).resolves.toBeUndefined();
  });

  it("a note that keeps throwing -> warns only once within 10 minutes and stays out of the batch; fails again on retry after expiry -> warns once more; once it succeeds it is no longer selected", async () => {
    let failing = true;
    const s = await setup();
    const good = await seedNote(s.db, { ownerId: s.u.id });
    const svc = s.mk({
      autoWaitMs: 0,
      testHooks: { beforeCutDue: async id => { if (failing && id === s.note.id) throw new Error("docFor 壞了（測試）"); } },
    });
    await s.store(s.note.id, ["壞的那篇"]);
    await s.store(good.id, ["好的那篇"]);
    await s.pend(s.note.id, at(0));
    await s.pend(good.id, at(1));
    const FAIL = "自動切版：單篇失敗，10 分鐘後再試";
    expect(await svc.scanDue(at(HOUR))).toBe(2);
    expect(s.warnsWith(FAIL)).toBe(1);
    expect(await versionsOf(s.db, good.id)).toHaveLength(1);
    expect(await svc.scanDue(at(HOUR + MIN))).toBe(0);
    expect(s.warnsWith(FAIL)).toBe(1);
    expect(await svc.scanDue(at(HOUR + VERSION_AUTO_SCAN_BACKOFF_MS))).toBe(1);
    expect(s.warnsWith(FAIL)).toBe(2);
    failing = false;
    expect(await svc.scanDue(at(HOUR + 2 * VERSION_AUTO_SCAN_BACKOFF_MS))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    expect(await svc.scanDue(at(HOUR + 2 * VERSION_AUTO_SCAN_BACKOFF_MS + MIN))).toBe(0);
    expect(s.warnsWith(FAIL)).toBe(2);
  });

  it("document loaded but version state not initialized (no Map entry) -> skipped every round, pending kept, warns only once; cut as usual in the next round after unload", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["載入了但沒初始化"]);
    await s.pend(s.note.id, at(0));
    s.host.docs.set(s.note.id, paraDoc(["載入了但沒初始化"]));
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    expect(s.warnsWith("版本狀態尚未初始化")).toBe(1);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("real shape: noteLoaded fails reading the DB and leaves an initialized:false entry -> skipped every round, pending kept, warns only once; after forget + unload the next round cuts as usual", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["條目沒初始化"]);
    await s.pend(s.note.id, at(0));
    s.host.docs.set(s.note.id, paraDoc(["條目沒初始化"]));
    // This is the shape left in the Map when noteLoaded's DB read fails (entryFor creates it first, never reaching initialized:true); noteChanged builds the same shape.
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    expect(s.svc.debugState(s.note.id)?.initialized).toBe(false);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    expect(s.warnsWith("版本狀態尚未初始化")).toBe(1);
    s.svc.forget(s.note.id);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });
});

describe("merging pending editors inside the transaction (manual save while pending)", () => {
  it("manual save: editors = pending + in-memory buffer + the saver (deduplicated, first come first served), pending cleared in the same transaction; the upgrade branch also clears pending and leaves the upgraded row's editors unchanged", async () => {
    const s = await setup();
    const other = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    s.host.docs.set(s.note.id, doc);
    await s.svc.noteLoaded(s.note.id, doc);
    await s.pend(s.note.id, at(0), [{ user_id: other.id, agent_label: "Claude" }]);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: other.id, agentLabel: null });
    const expected = [{ user_id: other.id, agent_label: "Claude" }, { user_id: other.id, agent_label: null }, s.me];
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "里程碑", extraEditors: [{ userId: s.u.id, agentLabel: null }] });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, kind: "manual", editors: expected } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    await s.pend(s.note.id, at(1), [{ user_id: s.u.id, agent_label: "X" }]);
    const up = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: null, extraEditors: [{ userId: s.u.id, agentLabel: null }] });
    expect(up).toMatchObject({ upgraded: true, row: { seq: 1, editors: expected } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("a note nobody has open is manually saved while pending (transient state) -> pending editors merge into the new version, pending cleared; later scans do not cut extra", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    await s.store(s.note.id, ["沒人開著時 AI 寫的"]);
    await s.pend(s.note.id, at(0), [claude], VACUUM_VERSION_FINGERPRINT);
    const { doc, transient } = await s.svc.docFor(s.note.id);
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "手存", extraEditors: [{ userId: s.u.id, agentLabel: null }], transient });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, editors: [claude, s.me] } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(await s.svc.scanDue(at(HOUR))).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });
});
