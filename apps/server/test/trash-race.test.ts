// Races between trash transactions, run on a throwaway pg: one side stops at a post-lock hook, the other is sent and confirmed with `waitForLockWaiters` to be really waiting
// on the lock (the interleaving really happened), then released and the outcome asserted to be exactly the specified one.
// The other form of move to trash x upload (personal note, existing attachment) is in `notes-delete-race.test.ts`; here it is a group note with a member upload, followed by permanent delete.
// The lock-order cases cover deleting a group (delete-all / transfer) x multi-id permanent delete/restore (locking by id removes the cycle), and the 409 when a restore/permanent delete is sacrificed concurrently.
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
const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };
const silent = pino({ level: "silent" }) as unknown as FastifyBaseLogger;

const del = (app: FastifyInstance, id: string, by: string) => inject(app, "DELETE", `/api/notes/${id}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const restoredIds = (r: Res) => (r.json() as TrashRestoreResultDto).restored.map(n => n.id);
const exists = async (pool: Pool, id: string) => (await pool.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;

/** One-shot test hook: the handler registered by `on` is removed and run on first trigger, later triggers pass through; `hits` counts how many times each point fired. */
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

async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** Waits for n connections stuck on locks; on timeout it releases first so in-flight requests finish, then throws the timeout (no dangling requests). */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

describe("move to trash x move to trash", () => {
  it("first stops after the lock, second waits on the lock -> 204 / 404; the later one's release does not release the earlier one's gate; deleted_by is the first person", async () => {
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
    // release is fire-and-forget (the 404 does not wait for it): wait for the later request's releaseDeletingGate to finish before looking at the gate.
    expect(rel).toHaveBeenCalledTimes(1);
    expect(await rel.mock.results.at(-1)!.value).toBe(false);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);
    expect((await trashCols(pool, n.id))?.deleted_by).toBe(s.admin.id);
  });
});

describe("restore x permanent delete", () => {
  it("restore stops after the lock, permanent delete waits on the lock -> restores 1 note, permanent delete skipped not_in_trash, the note is alive", async () => {
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

  it("permanent delete stops after the lock, restore (pre-check already passed) waits on the lock -> permanent delete 1 note, restore skipped not_found, row and attachment files are gone", async () => {
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

describe("restore x cleanup", () => {
  it("restore stops after the lock -> cleanup SKIP LOCKED does not wait and returns 0; after the restore the next round does not delete either (live note)", async () => {
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

  it("cleanup stops after the lock, restore waits on the lock -> cleanup deletes, restore skipped not_found", async () => {
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

describe("move to trash x upload, then permanent delete", () => {
  it("upload stops inside the transaction (holding KEY SHARE), trash waits on the lock -> upload 201, trash 204; permanent delete removes the attachment file too, no orphan on disk", async () => {
    const s = await uploadScene();
    const up = s.seams.hold("storage-space-locked");
    let replied!: () => void;
    const uploadReplied = new Promise<void>(r => { replied = r; });
    // After the trash gets the lock it waits for the upload's response to be sent before continuing (does not race the response after the upload commits).
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

  it("trash stops after the lock, upload (already authorized) waits on the lock -> trash 204, upload 404 not_found, uploads has 0 rows, no new file on disk; permanent delete afterwards works as usual", async () => {
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

describe("role downgrade x restore", () => {
  const demote = (pool: Pool, groupId: string, userId: string) =>
    pool.query(`update group_roles set can_delete = false where id = (select role_id from group_members where group_id = $1 and user_id = $2)`, [groupId, userId]);

  it("restore (pre-check already passed) stops after the lock while can_delete is removed -> re-judged inside the transaction as skipped not_found, still in trash", async () => {
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

  it("downgrade first, then restore -> not_found already at the pre-check (never enters the transaction), still in trash", async () => {
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
 * Deleting a group x multi-id permanent delete/restore lock order (a shape that deadlocked in real runs).
 * Two notes a < b by id, but delete-all's scan order (physical, or the slug order of `notes_group_slug_idx`) and transfer's created_at order both go b first.
 * The fix: delete-all and transfer both lock in ascending id (same order as the three trash endpoints and `deleteNotesInTx`), and transfer's slug processing order is sorted in JS by created_at, id.
 * Deterministic construction: the test connection holds a's row lock first -> permanent delete/restore queues on a (nothing locked yet) -> deleting the group also queues on a -> the test releases a:
 * a's queue is FIFO, so permanent delete/restore gets a first, then b, and commits; deleting the group gets its locks after. Reverting to the old lock order (group delete locks b then waits on a) forms a cycle -> 40P01.
 */
async function deadlockScene(order: "scan" | "created") {
  const seams = new Seams();
  const logs = captureLogs();
  const hooks = spyCollabHooks();
  const built = await buildTestApp({ groupTestHook: seams.group, collabHooks: hooks }, logs.options);
  const { db } = built;
  const pool = db.$client;
  const admin = await seedUser(db);
  const g = await seedGroup(db, "RC-DL", [{ userId: admin.id, role: "admin" }]);
  const [a, b] = [randomUUID(), randomUUID()].sort();
  const now = Date.now();
  // b is inserted first (earlier physical order), has the smaller slug (an index scan on `(group_id, slug)` is also b first) and the earlier created_at - the old delete-all and transfer lock order was
  // b then a; permanent delete/restore goes a first.
  await db.insert(notes).values({ id: b!, groupId: g.id, slug: "dl-1", createdAt: new Date(now - 60_000) });
  await db.insert(notes).values({ id: a!, groupId: g.id, slug: "dl-2", createdAt: new Date(now) });
  // Moving to trash is an UPDATE and writes new tuples: write in b, a order so the new versions keep b first physically.
  for (const id of [b!, a!]) await markTrashed(pool, id, admin.id);
  if (order === "scan") {
    const { rows } = await pool.query<{ id: string }>(`select id from notes where group_id = $1`, [g.id]);
    expect(rows.map(r => r.id), "前提：不帶 ORDER BY 的掃描順序是 b、a").toEqual([b, a]);
  }
  return { ...built, pool, seams, logs, hooks, admin, groupId: g.id, a: a!, b: b! };
}

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

async function queueBehindA(
  s: Awaited<ReturnType<typeof deadlockScene>>,
  first: () => Promise<Res>,
  body: Record<string, unknown>,
): Promise<{ firstReq: Promise<Res>; deleting: Promise<Res> }> {
  const holder = await holdRow(s.pool, s.a);
  let firstReq: Promise<Res> | undefined;
  let deleting: Promise<Res> | undefined;
  try {
    firstReq = first();
    await waitForLockWaiters(s.pool, 1);
    deleting = inject(s.app, "DELETE", `/api/groups/${s.groupId}`, s.admin.id, body);
    await waitForLockWaiters(s.pool, 2);
  } finally {
    await holder.release();
  }
  return { firstReq: firstReq!, deleting: deleting! };
}

const unhandled = (s: { logs: ReturnType<typeof captureLogs> }) => s.logs.lines.filter(l => l.msg === "unhandled error");

for (const mode of ["delete", "transfer"] as const) {
  describe(`deleting a group (${mode === "delete" ? "delete all" : "transfer"}) x multi-id permanent delete`, () => {
    it("both sides lock by id -> no deadlock: permanent delete 200 purged [a, b], group delete 204, no unhandled error in the log", async () => {
      const s = await deadlockScene(mode === "delete" ? "scan" : "created");
      const body = mode === "delete" ? { mode } : { mode, transferTo: s.admin.id };
      const { firstReq, deleting } = await queueBehindA(s, () => purge(s.app, s.admin.id, [s.a, s.b]), body);
      const [pr, dr] = await Promise.all([firstReq, deleting]);

      expect(pr.statusCode, pr.body).toBe(200);
      expect(pr.json()).toEqual({ purged: [s.a, s.b], skipped: [] } satisfies TrashPurgeResultDto);
      expect(dr.statusCode, dr.body).toBe(204);
      expect(await s.db.select({ id: groups.id }).from(groups).where(eq(groups.id, s.groupId))).toEqual([]);
      // Transfer also moved 0 notes: both were permanently deleted before it got the lock.
      expect([await exists(s.pool, s.a), await exists(s.pool, s.b)]).toEqual([false, false]);
      expect(unhandled(s)).toEqual([]);
    });
  });
}

describe("transfer x multi-id restore", () => {
  it("no deadlock: restore 200 restored [a, b]; transfer 204, both become the recipient's personal notes and alive; no unhandled error in the log", async () => {
    const s = await deadlockScene("created");
    // After getting the lock, transfer stops at the first slug candidate until restore's response (the re-read after restore's commit) is done - otherwise the re-read races the transfer's commit.
    const cand = s.seams.hold("group-transfer-slug-candidate");
    const { firstReq, deleting } = await queueBehindA(s, () => restore(s.app, s.admin.id, [s.a, s.b]), {
      mode: "transfer",
      transferTo: s.admin.id,
    });
    let rr: Res;
    try {
      rr = await firstReq;
    } finally {
      cand.open();
    }
    const dr = await deleting;

    expect(rr.statusCode, rr.body).toBe(200);
    expect(restoredIds(rr)).toEqual([s.a, s.b]);
    expect((rr.json() as TrashRestoreResultDto).skipped).toEqual([]);
    expect(s.hooks.onNotesRestored.mock.calls).toEqual([[[s.a, s.b]]]);
    expect(dr.statusCode, dr.body).toBe(204);
    expect(await s.db.select({ id: groups.id }).from(groups).where(eq(groups.id, s.groupId))).toEqual([]);
    const rows = await s.db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes);
    expect(rows.sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([
      { id: s.a, ownerId: s.admin.id, groupId: null },
      { id: s.b, ownerId: s.admin.id, groupId: null },
    ]);
    for (const id of [s.a, s.b]) expect(await trashCols(s.pool, id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(unhandled(s)).toEqual([]);
  });
});

describe("defence in depth: a restore/permanent delete transaction sacrificed concurrently -> 409 server_busy", () => {
  for (const code of ["40P01", "40001"]) {
    for (const op of ["purge", "restore"] as const) {
      it(`${op} throws ${code} inside the transaction -> 409 server_busy, nothing done, no unhandled error in the log`, async () => {
        const logs = captureLogs();
        const hooks = spyCollabHooks();
        const point = op === "purge" ? "note-purge-locked" : "note-restore-locked";
        const groupTestHook: GroupTestHook = async p => {
          if (p === point) throw Object.assign(new Error("concurrent tx failure"), { code });
        };
        const { app, db, uploadsDir } = await buildTestApp({ groupTestHook, collabHooks: hooks }, logs.options);
        const pool = db.$client;
        const owner = await seedUser(db);
        const n = await seedNote(db, { ownerId: owner.id });
        const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 12);
        await markTrashed(pool, n.id, owner.id);

        const r = op === "purge" ? await purge(app, owner.id, [n.id]) : await restore(app, owner.id, [n.id]);

        expect(r.statusCode, r.body).toBe(409);
        expect(r.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
        expect(await trashCols(pool, n.id)).toEqual({ deleted_at: expect.any(String), deleted_by: owner.id });
        expect((await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, n.id))).map(u => u.id)).toEqual([up]);
        expect(await filesIn(uploadsDir)).toEqual([up]);
        expect(hooks.onNotesRestored).not.toHaveBeenCalled();
        expect(logs.lines.filter(l => l.msg === "unhandled error")).toEqual([]);
      });
    }
  }
});
