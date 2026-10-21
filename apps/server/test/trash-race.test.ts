/**
 * #181 PR-2a T12：垃圾桶交易彼此的併發（spec §6.14、A2-16 併發半、M-D）。以拋棄式 pg 實跑：一方卡在 T3 的鎖後縫，
 * 另一方送出後以 `waitForLockWaiters` 確認它真的在等鎖（交錯真的發生），放行後斷言結果只會是指定的那一種。
 * 「移入×上傳」的另一形（個人筆記、既有附件）在 `notes-delete-race.test.ts`；這裡是群組筆記、成員上傳，並接著永久刪除。
 * RC-DL：刪群組（全刪／轉移）× 多 id 永久刪除的鎖序成環——記錄現況（產品缺陷，見各案註解）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import { groups, notes, uploads } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { createTrashPurger } from "../src/trash/purge.js";
import { seedGroup, seedNote, seedUser, spyCollabHooks, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { filesIn, giveGroupQuota, seedAttachment, upload } from "./storage-helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

type Res = LightMyRequestResponse;
const NOT_FOUND = { error: { code: "not_found", message: "找不到此筆記" } };
const silent = pino({ level: "silent" }) as unknown as FastifyBaseLogger;

const del = (app: FastifyInstance, id: string, by: string) => inject(app, "DELETE", `/api/notes/${id}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const restoredIds = (r: Res) => (r.json() as TrashRestoreResultDto).restored.map(n => n.id);
const exists = async (pool: Pool, id: string) => (await pool.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;

/** 一次性測試縫：`on` 登記的處理第一次觸發時拿掉並執行，其餘觸發直接放行；`hits` 記每個點被觸發幾次。 */
class Seams {
  private readonly handlers = new Map<string, () => Promise<void>>();
  readonly hits = new Map<string, number>();
  on(name: string, fn: () => Promise<void>): void {
    this.handlers.set(name, fn);
  }
  async fire(name: string): Promise<void> {
    this.hits.set(name, (this.hits.get(name) ?? 0) + 1);
    const fn = this.handlers.get(name);
    if (!fn) return;
    this.handlers.delete(name);
    await fn();
  }
  /** 在 name 卡住：`entered` 在進縫時 resolve，`open()` 放行。 */
  hold(name: string): { entered: Promise<void>; open: () => void } {
    let open!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const entered = new Promise<void>(r => { enter = r; });
    this.on(name, async () => {
      enter();
      await gate;
    });
    return { entered, open };
  }
  readonly group: GroupTestHook = point => this.fire(point);
}

/** 等請求走進縫；它若先回應了（沒走到縫）就直接失敗，不空等。 */
async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** 等 n 條連線卡在鎖上；逾時就先放行、讓在途請求收尾，再把逾時丟出去（不留懸著的請求）。 */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

describe("RC1 移入 × 移入（M-D）", () => {
  it("第一個卡在鎖後、第二個等鎖 → 204／404；後到那次的 release 不收掉先到那次的閘門；deleted_by 是第一個人", async () => {
    const seams = new Seams();
    const ctx = await buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log), groupTestHook: seams.group });
    const pool: Pool = ctx.db.$client;
    const s = await sixRoleScene(ctx.db);
    const n = await seedNote(ctx.db, { groupId: s.groupId });
    const rel = vi.spyOn(ctx.collab, "releaseDeletingGate");
    const first = seams.hold("note-trash-locked");

    const d1 = del(ctx.app, n.id, s.admin.id);
    await entered(first.entered, d1);
    const d2 = del(ctx.app, n.id, s.editDelete.id);
    await blockedOrBail(pool, 1, first.open, [d1, d2]);
    first.open();

    expect((await d1).statusCode).toBe(204);
    const r2 = await d2;
    expect(r2.statusCode, r2.body).toBe(404);
    expect(r2.json()).toEqual(NOT_FOUND);
    // release 是 fire-and-forget（404 不等它）：等後到那次的 releaseDeletingGate 跑完再看閘門。
    expect(rel).toHaveBeenCalledTimes(1);
    expect(await rel.mock.results.at(-1)!.value).toBe(false);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);
    expect((await trashCols(pool, n.id))?.deleted_by).toBe(s.admin.id);
  });
});

describe("RC2 還原 × 永久刪除", () => {
  it("(a) 還原卡在鎖後、永久刪除等鎖 → 還原 1 篇、永久刪除 skipped not_in_trash、筆記活著", async () => {
    const seams = new Seams();
    const hooks = spyCollabHooks();
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seams.group, collabHooks: hooks });
    const pool = db.$client;
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 12);
    await markTrashed(pool, n.id, owner.id);
    const r = seams.hold("note-restore-locked");

    const restoring = restore(app, owner.id, [n.id]);
    await entered(r.entered, restoring);
    const purging = purge(app, owner.id, [n.id]);
    await blockedOrBail(pool, 1, r.open, [restoring, purging]);
    r.open();

    const rr = await restoring;
    expect(rr.statusCode, rr.body).toBe(200);
    expect(restoredIds(rr)).toEqual([n.id]);
    expect((rr.json() as TrashRestoreResultDto).skipped).toEqual([]);
    const pr = await purging;
    expect(pr.statusCode, pr.body).toBe(200);
    expect(pr.json()).toEqual({ purged: [], skipped: [{ id: n.id, reason: "not_in_trash" }] } satisfies TrashPurgeResultDto);
    expect(await trashCols(pool, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await filesIn(uploadsDir)).toEqual([up]);
    expect(hooks.onNotesRestored.mock.calls).toEqual([[[n.id]]]);
  });

  it("(b) 永久刪除卡在鎖後、還原（預判已過）等鎖 → 永久刪除 1 篇、還原 skipped not_found、列與附件檔都不在", async () => {
    const seams = new Seams();
    const hooks = spyCollabHooks();
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seams.group, collabHooks: hooks });
    const pool = db.$client;
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedAttachment(db, uploadsDir, n.id, owner.id, 12);
    await markTrashed(pool, n.id, owner.id);
    const p = seams.hold("note-purge-locked");

    const purging = purge(app, owner.id, [n.id]);
    await entered(p.entered, purging);
    const restoring = restore(app, owner.id, [n.id]);
    await blockedOrBail(pool, 1, p.open, [purging, restoring]);
    p.open();

    const pr = await purging;
    expect(pr.statusCode, pr.body).toBe(200);
    expect(pr.json()).toEqual({ purged: [n.id], skipped: [] });
    const rr = await restoring;
    expect(rr.statusCode, rr.body).toBe(200);
    expect(rr.json()).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect(seams.hits.get("note-restore-locked"), "還原真的進了交易（不是預判擋掉）").toBe(1);
    expect(await exists(pool, n.id)).toBe(false);
    expect(await filesIn(uploadsDir)).toEqual([]);
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });
});

describe("RC3 還原 × 清理", () => {
  it("(a) 還原卡在鎖後 → 清理 SKIP LOCKED 不等鎖、回 0；還原後下一輪也不刪（活筆記）", async () => {
    const seams = new Seams();
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seams.group });
    const pool = db.$client;
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await markTrashed(pool, n.id, owner.id, "8 days");
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    const r = seams.hold("note-restore-locked");

    const restoring = restore(app, owner.id, [n.id]);
    await entered(r.entered, restoring);
    const run = purger.runOnce();
    const interleave = await waitForBlockedOrSettled(pool, run).catch((err: unknown) => {
      r.open();
      throw err;
    });
    if (interleave !== "settled") {
      r.open();
      await Promise.allSettled([run, restoring]);
    }
    expect(interleave).toBe("settled");
    expect(await run).toBe(0);
    r.open();

    const rr = await restoring;
    expect(rr.statusCode, rr.body).toBe(200);
    expect(restoredIds(rr)).toEqual([n.id]);
    expect(await purger.runOnce()).toBe(0);
    expect(await trashCols(pool, n.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("(b) 清理卡在鎖後、還原等鎖 → 清理刪掉、還原 skipped not_found", async () => {
    const seams = new Seams();
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seams.group });
    const pool = db.$client;
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await markTrashed(pool, n.id, owner.id, "8 days");
    const purger = createTrashPurger({ db, log: silent, uploadsDir, groupTestHook: seams.group });
    const c = seams.hold("trash-purge-locked");

    const run = purger.runOnce();
    await c.entered;
    const restoring = restore(app, owner.id, [n.id]);
    await blockedOrBail(pool, 1, c.open, [run, restoring]);
    c.open();

    expect(await run).toBe(1);
    const rr = await restoring;
    expect(rr.statusCode, rr.body).toBe(200);
    expect(rr.json()).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect(seams.hits.get("note-restore-locked"), "還原真的進了交易").toBe(1);
    expect(await exists(pool, n.id)).toBe(false);
  });
});

/** RC4 的場景：群組筆記、管理員移入與永久刪除、一般成員（有編輯權）上傳。 */
async function uploadScene() {
  const seams = new Seams();
  const built = await buildTestApp({ groupTestHook: seams.group });
  const { db } = built;
  const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
  const g = await seedGroup(db, "RC4", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
  await giveGroupQuota(db, g.id, null);
  const n = await seedNote(db, { groupId: g.id });
  return { ...built, pool: db.$client, seams, admin, member, noteId: n.id };
}
const uploadRows = async (db: Db, noteId: string) => (await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, noteId))).map(r => r.id);

describe("RC4 移入 × 上傳，之後永久刪除", () => {
  it("(a) 上傳卡在交易內（持 KEY SHARE）、移入等鎖 → 上傳 201、移入 204；永久刪除連同該附件檔刪掉，磁碟沒有孤兒", async () => {
    const s = await uploadScene();
    const up = s.seams.hold("storage-space-locked");
    let replied!: () => void;
    const uploadReplied = new Promise<void>(r => { replied = r; });
    // 移入拿到鎖之後等上傳回完應答再繼續（不和上傳 commit 後的回應競速）。
    s.seams.on("note-trash-locked", () => uploadReplied);

    const uploading = upload(s.app, s.noteId, s.member.id, 8);
    await entered(up.entered, uploading);
    const deleting = del(s.app, s.noteId, s.admin.id);
    await blockedOrBail(s.pool, 1, () => { up.open(); replied(); }, [uploading, deleting]);
    up.open();
    const ur = await uploading;
    replied();
    expect(ur.statusCode, ur.body).toBe(201);
    expect((await deleting).statusCode).toBe(204);
    const ids = await uploadRows(s.db, s.noteId);
    expect(ids).toHaveLength(1);
    expect(await filesIn(s.uploadsDir)).toEqual(ids);

    const pr = await purge(s.app, s.admin.id, [s.noteId]);
    expect(pr.json()).toEqual({ purged: [s.noteId], skipped: [] });
    expect(await uploadRows(s.db, s.noteId)).toEqual([]);
    expect(await filesIn(s.uploadsDir)).toEqual([]);
  });

  it("(b) 移入卡在鎖後、上傳（已授權）等鎖 → 移入 204、上傳 404 not_found、uploads 0 列、磁碟無新檔；之後永久刪除照常", async () => {
    const s = await uploadScene();
    const tr = s.seams.hold("note-trash-locked");

    const deleting = del(s.app, s.noteId, s.admin.id);
    await entered(tr.entered, deleting);
    const uploading = upload(s.app, s.noteId, s.member.id, 8);
    await blockedOrBail(s.pool, 1, tr.open, [deleting, uploading]);
    tr.open();

    expect((await deleting).statusCode).toBe(204);
    const ur = await uploading;
    expect(ur.statusCode, ur.body).toBe(404);
    expect(ur.json()).toEqual(NOT_FOUND);
    expect(await uploadRows(s.db, s.noteId)).toEqual([]);
    expect(await filesIn(s.uploadsDir)).toEqual([]);

    const pr = await purge(s.app, s.admin.id, [s.noteId]);
    expect(pr.json()).toEqual({ purged: [s.noteId], skipped: [] });
    expect(await exists(s.pool, s.noteId)).toBe(false);
  });
});

describe("RC5 角色降級 × 還原", () => {
  const demote = (pool: Pool, groupId: string, userId: string) =>
    pool.query(`update group_roles set can_delete = false where id = (select role_id from group_members where group_id = $1 and user_id = $2)`, [groupId, userId]);

  it("(a) 還原（預判已過）卡在鎖後，期間 can_delete 被拿掉 → 交易內重判 skipped not_found、仍在垃圾桶", async () => {
    const seams = new Seams();
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ groupTestHook: seams.group, collabHooks: hooks });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool, n.id, s.editDelete.id);
    const r = seams.hold("note-restore-locked");

    const restoring = restore(app, s.editDelete.id, [n.id]);
    await entered(r.entered, restoring);
    await demote(pool, s.groupId, s.editDelete.id);
    r.open();

    const rr = await restoring;
    expect(rr.statusCode, rr.body).toBe(200);
    expect(rr.json()).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect((await trashCols(pool, n.id))?.deleted_at).not.toBeNull();
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });

  it("(b) 先降級再還原 → 預判就 not_found（沒進交易）、仍在垃圾桶", async () => {
    const seams = new Seams();
    const { app, db } = await buildTestApp({ groupTestHook: seams.group });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool, n.id, s.editDelete.id);
    await demote(pool, s.groupId, s.editDelete.id);

    const rr = await restore(app, s.editDelete.id, [n.id]);

    expect(rr.statusCode, rr.body).toBe(200);
    expect(rr.json()).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect(seams.hits.get("note-restore-locked") ?? 0, "預判擋掉、沒開交易").toBe(0);
    expect((await trashCols(pool, n.id))?.deleted_at).not.toBeNull();
  });
});

/**
 * RC-DL：刪群組 × 多 id 永久刪除的鎖序成環（資料夾 spec gate 實跑 5/14 撞到的形）。永久刪除依 id 升冪鎖；全刪以群組述詞
 * 鎖、沒有 ORDER BY（實體順序）；轉移依 created_at, id 鎖。兩篇 a < b（id），但全刪／轉移的鎖序是 b 先。
 * 決定性的造法：測試連線先持 a 的列鎖 → 永久刪除排在 a 上（什麼都還沒鎖）→ 刪群組鎖住 b、排在 a 上 → 測試放掉 a：
 * 永久刪除拿到 a、去等 b；刪群組等 a ⇒ 40P01，犧牲者由 PG 的 deadlock_timeout 先到者決定（兩種都可能）。
 * ⚠ 這是**產品缺陷的現況記錄**：修好（全刪依 id 鎖；轉移依 id 鎖、slug 處理順序在 JS 依 created_at, id 排）之後兩邊都成功，
 * 本案要改成斷言「沒有死結」。犧牲者是刪群組 → 409 server_busy；是永久刪除 → 500 internal（purge 沒有 server_busy 映射）。
 */
async function deadlockScene(order: "physical" | "created") {
  const seams = new Seams();
  const logs = captureLogs();
  const built = await buildTestApp({ groupTestHook: seams.group, collabHooks: spyCollabHooks() }, logs.options);
  const { db } = built;
  const pool = db.$client;
  const admin = await seedUser(db);
  const g = await seedGroup(db, "RC-DL", [{ userId: admin.id, role: "admin" }]);
  const [a, b] = [randomUUID(), randomUUID()].sort();
  const now = Date.now();
  // b 先插（實體順序在前）、slug 較小（`(group_id, slug)` 索引掃描也是 b 先）、created_at 也較早——全刪與轉移的鎖序都是
  // b 先、a 後；永久刪除是 a 先。
  await db.insert(notes).values({ id: b!, groupId: g.id, slug: "dl-1", createdAt: new Date(now - 60_000) });
  await db.insert(notes).values({ id: a!, groupId: g.id, slug: "dl-2", createdAt: new Date(now) });
  // 移入是 UPDATE、會寫新的 tuple：照 b、a 的順序寫，新版本的實體順序才維持 b 先。
  for (const id of [b!, a!]) await markTrashed(pool, id, admin.id);
  if (order === "physical") {
    const { rows } = await pool.query<{ id: string }>(`select id from notes where group_id = $1`, [g.id]);
    expect(rows.map(r => r.id), "前提：全刪的掃描順序是 b、a").toEqual([b, a]);
  }
  return { ...built, pool, seams, logs, admin, groupId: g.id, a: a!, b: b! };
}

/** 測試連線持 a 的列鎖；回放鎖函式。 */
async function holdRow(pool: Pool, id: string): Promise<{ client: PoolClient; release: () => Promise<void> }> {
  const client = await pool.connect();
  await client.query("begin");
  await client.query(`select 1 from notes where id = $1 for update`, [id]);
  let done = false;
  return {
    client,
    release: async () => {
      if (done) return;
      done = true;
      await client.query("rollback");
      client.release();
    },
  };
}

const errCodeOf = (e: unknown): unknown => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return err?.code ?? err?.cause?.code;
};

for (const mode of ["delete", "transfer"] as const) {
  describe(`RC-DL ${mode === "delete" ? "全刪" : "轉移"} × 多 id 永久刪除（現況：40P01）`, () => {
    it("兩條交易以相反順序鎖同兩篇 → 死結，一方 40P01（刪群組 409 server_busy／永久刪除 500），另一方完整生效、資料不壞", async () => {
      const s = await deadlockScene(mode === "delete" ? "physical" : "created");
      const holder = await holdRow(s.pool, s.a);
      const body = mode === "delete" ? { mode } : { mode, transferTo: s.admin.id };
      let purging: Promise<Res> | undefined;
      let deleting: Promise<Res> | undefined;
      try {
        purging = purge(s.app, s.admin.id, [s.a, s.b]);
        await waitForLockWaiters(s.pool, 1);
        deleting = inject(s.app, "DELETE", `/api/groups/${s.groupId}`, s.admin.id, body);
        await waitForLockWaiters(s.pool, 2);
      } finally {
        await holder.release();
      }
      const [pr, dr] = await Promise.all([purging!, deleting!]);
      const groupLeft = (await s.db.select({ id: groups.id }).from(groups).where(eq(groups.id, s.groupId))).length;

      if (dr.statusCode === 409) {
        // 刪群組是犧牲者：整個交易回滾（群組還在），永久刪除完整生效。
        expect(dr.json()).toEqual({ error: { code: "server_busy", message: "伺服器忙碌，請稍後再試" } });
        expect(pr.statusCode, pr.body).toBe(200);
        expect(pr.json()).toEqual({ purged: [s.a, s.b], skipped: [] });
        expect(groupLeft).toBe(1);
        expect([await exists(s.pool, s.a), await exists(s.pool, s.b)]).toEqual([false, false]);
      } else {
        // 永久刪除是犧牲者：500，log 的錯是 40P01；刪群組完整生效。
        expect(dr.statusCode, dr.body).toBe(204);
        expect(pr.statusCode, pr.body).toBe(500);
        expect(pr.json()).toEqual({ error: { code: "internal", message: "伺服器內部錯誤" } });
        const line = s.logs.lines.find(l => l.msg === "unhandled error");
        expect(errCodeOf(line?.obj.err)).toBe("40P01");
        expect(groupLeft).toBe(0);
        if (mode === "delete") {
          expect([await exists(s.pool, s.a), await exists(s.pool, s.b)]).toEqual([false, false]);
        } else {
          // 轉移：兩篇成了接收者的個人筆記，仍在垃圾桶（deleted_* 不動）。
          const rows = await s.db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes);
          expect(rows.sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([
            { id: s.a, ownerId: s.admin.id, groupId: null },
            { id: s.b, ownerId: s.admin.id, groupId: null },
          ]);
          for (const id of [s.a, s.b]) expect((await trashCols(s.pool, id))?.deleted_by).toBe(s.admin.id);
        }
      }
    });
  });
}
