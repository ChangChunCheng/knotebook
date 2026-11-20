import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { groups, noteVersions, notes, users } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { seedDoc } from "./copy-helpers.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { NO_PENDING, baseVersionIdOf, noteBase, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
async function save(app: FastifyInstance, noteId: string, userId: string) {
  return app.inject({ method: "POST", url: `/api/notes/${noteId}/versions`, cookies: await cookieOf(userId), payload: {} });
}

describe("REST form (not loaded)", () => {
  it("copy: the copy has zero versions, count 0, base NULL; the source is untouched", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, src.id, paraDoc(["來源"]));
    expect((await save(app, src.id, u.id)).statusCode).toBe(201);
    const r = await app.inject({ method: "POST", url: `/api/notes/${src.id}/copy`, cookies: await cookieOf(u.id), payload: {} });
    expect(r.statusCode).toBe(201);
    const copyId = r.json().id as string;
    expect(await versionsOf(db, copyId)).toEqual([]);
    expect(await noteBase(db, copyId)).toEqual({ counter: 0, baseSeq: null, baseFingerprint: null });
    expect(await versionsOf(db, src.id)).toHaveLength(1);
    expect((await noteBase(db, src.id)).baseSeq).toBe(1);
  });

  it("move to a group: versions cleared, count 0, base NULL; GET list empty, nextSeq 1", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(["個人時期"]));
    expect((await save(app, n.id, u.id)).statusCode).toBe(201);
    const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(u.id), payload: { groupId: g.id } });
    expect(r.statusCode).toBe(200);
    expect(await versionsOf(db, n.id)).toEqual([]);
    expect(await noteBase(db, n.id)).toEqual({ counter: 0, baseSeq: null, baseFingerprint: null });
    const list = (await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions`, cookies: await cookieOf(u.id) })).json();
    expect(list).toMatchObject({ versions: [], current: { baseSeq: null, nextSeq: 1 }, nextBefore: null });
  });

  it("delete a group with transfer: every note is cleared; delete-all (delete mode) goes through CASCADE", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedNote(db, { groupId: g.id });
      await seedDoc(db, n.id, paraDoc([`群組第 ${i} 篇`]));
      expect((await save(app, n.id, u.id)).statusCode).toBe(201);
      ids.push(n.id);
    }
    const r = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(u.id), payload: { mode: "transfer", transferTo: u.id } });
    expect(r.statusCode).toBe(204);
    for (const id of ids) {
      expect(await versionsOf(db, id)).toEqual([]);
      expect(await noteBase(db, id)).toEqual({ counter: 0, baseSeq: null, baseFingerprint: null });
    }
    const g2 = await seedGroup(db, "H", [{ userId: u.id, role: "admin" }]);
    const n2 = await seedNote(db, { groupId: g2.id });
    await seedDoc(db, n2.id, paraDoc(["會被全刪"]));
    expect((await save(app, n2.id, u.id)).statusCode).toBe(201);
    expect(await db.select().from(noteVersions).where(eq(noteVersions.noteId, n2.id))).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g2.id}`, cookies: await cookieOf(u.id), payload: { mode: "delete" } })).statusCode).toBe(204);
    expect(await db.select().from(noteVersions).where(eq(noteVersions.noteId, n2.id))).toEqual([]);
  });

  it("#272 (DB level): move to a group and delete-group transfer clear the three pending columns and the base uuid in the same statement; a copy has no pending, the source's pending is untouched", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const pending = { versionPendingAt: new Date("2026-10-14T00:00:00.000Z"), versionPendingEditors: [{ user_id: u.id, agent_label: null }], versionPendingRefFingerprint: "ref" };
    const src = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, src.id, paraDoc(["來源"]));
    await db.update(notes).set(pending).where(eq(notes.id, src.id));
    const copied = await app.inject({ method: "POST", url: `/api/notes/${src.id}/copy`, cookies: await cookieOf(u.id), payload: {} });
    expect(copied.statusCode).toBe(201);
    expect(await pendingOf(db, copied.json().id as string)).toEqual(NO_PENDING);
    expect(await pendingOf(db, src.id)).toEqual({ at: pending.versionPendingAt, editors: pending.versionPendingEditors, ref: "ref" });
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(["個人時期"]));
    expect((await save(app, n.id, u.id)).statusCode).toBe(201);
    expect(await baseVersionIdOf(db, n.id)).not.toBeNull();
    await db.update(notes).set(pending).where(eq(notes.id, n.id));
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(u.id), payload: { groupId: g.id } })).statusCode).toBe(200);
    expect(await pendingOf(db, n.id)).toEqual(NO_PENDING);
    expect(await baseVersionIdOf(db, n.id)).toBeNull();
    const gn = await seedNote(db, { groupId: g.id });
    await seedDoc(db, gn.id, paraDoc(["群組時期"]));
    expect((await save(app, gn.id, u.id)).statusCode).toBe(201);
    for (const id of [n.id, gn.id]) await db.update(notes).set(pending).where(eq(notes.id, id));
    const r = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(u.id), payload: { mode: "transfer", transferTo: u.id } });
    expect(r.statusCode).toBe(204);
    for (const id of [n.id, gn.id]) {
      expect(await pendingOf(db, id)).toEqual(NO_PENDING);
      expect(await baseVersionIdOf(db, id)).toBeNull();
    }
  });
});

describe("loaded notes (real collab)", () => {
  async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
    const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0, ...opts });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "admin" }]);
    const move = () => session.fetch(`/api/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ groupId: g.id }) });
    const unloaded = () => waitFor("卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    return { ctx, u, note, session, g, move, unloaded };
  }

  it("state is rebuilt after a move (spaceKey becomes the group); edit again, leave, scan -> a new v1; GET /versions/1 returns the new v1", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "個人時期的內容");
    const live = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    await s.ctx.collab.versions.cutIfDirty(s.note.id, live, { kind: "manual" });
    const oldV1 = (await versionsOf(s.ctx.db, s.note.id))[0]!;
    expect((await s.move()).status).toBe(200);
    await waitFor("狀態重建", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.initialized === true);
    expect(s.ctx.collab.versions.debugState(s.note.id)!.spaceKey).toBe(`g:${s.g.id}`);
    const p = topLevelBlocks(client.doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as import("yjs").XmlElement;
    client.doc.transact(() => (p.get(0) as import("yjs").XmlText).insert(0, "群組時期"));
    await waitFor("server 收到", 5_000, () => docText(live).includes("群組時期"));
    client.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => r.seq)).toEqual([1]);
    expect(rows[0]!.id).not.toBe(oldV1.id);
    expect(rows[0]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    const snap = await s.session.fetch(`/api/notes/${s.note.id}/versions/1`);
    expect((await snap.json()).id).toBe(rows[0]!.id);
  });

  it("note with no base: an automatic cut waits on the lock while the move holds the row lock -> after the move commits it rolls back because spaceKey no longer matches -> zero versions", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    let paused: () => void = () => {};
    const pausedP = new Promise<void>(r => { paused = r; });
    const hook = async (point: GroupRacePoint) => {
      if (point === "note-move-locked") {
        paused();
        await gate;
      }
    };
    const s = await setup({ groupTestHook: hook });
    const client = await seedContent(s.ctx, s.session, s.note.id, "沒存過的個人內容");
    const live = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    const moving = s.move();
    await pausedP; // The move transaction already holds that row FOR UPDATE.
    const cut = s.ctx.collab.versions.cutIfDirty(s.note.id, live, { kind: "auto" });
    expect(await waitForBlockedOrSettled(s.ctx.db.$client, cut)).toBe("blocked");
    release();
    expect((await moving).status).toBe(200);
    expect(await cut).toBeNull();
    client.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]); // loadFingerprint = the current content at rebuild and the move cleared pending, so the scan does not cut
  });

  it("moved into a group with auto-save off -> autoEnabled=false, zero versions after leaving and scanning", async () => {
    const s = await setup();
    await s.ctx.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, s.g.id));
    const client = await seedContent(s.ctx, s.session, s.note.id, "個人時期");
    expect((await s.move()).status).toBe(200);
    await waitFor("狀態重建", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.initialized === true);
    expect(s.ctx.collab.versions.debugState(s.note.id)!.autoEnabled).toBe(false);
    client.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("delete group with transfer while the group note is loaded -> state rebuilt (spaceKey becomes u:<transferTo>, autoEnabled follows the recipient's personal switch = false); zero versions after leaving and scanning", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const gn = await seedNote(s.ctx.db, { groupId: s.g.id });
    const client = await seedContent(s.ctx, s.session, gn.id, "群組時期的內容");
    await waitFor("初始狀態", 5_000, () => s.ctx.collab.versions.debugState(gn.id)?.initialized === true);
    expect(s.ctx.collab.versions.debugState(gn.id)).toMatchObject({ spaceKey: `g:${s.g.id}`, autoEnabled: true });
    const r = await s.session.fetch(`/api/groups/${s.g.id}`, { method: "DELETE", body: JSON.stringify({ mode: "transfer", transferTo: s.u.id }) });
    expect(r.status).toBe(204);
    await waitFor("狀態重建", 5_000, () => s.ctx.collab.versions.debugState(gn.id)?.spaceKey === `u:${s.u.id}`);
    expect(s.ctx.collab.versions.debugState(gn.id)).toMatchObject({ initialized: true, spaceKey: `u:${s.u.id}`, autoEnabled: false });
    client.disconnect();
    await s.unloaded();
    await s.ctx.collab.versions.scanDue();
    expect(await versionsOf(s.ctx.db, gn.id)).toEqual([]);
  });
});
