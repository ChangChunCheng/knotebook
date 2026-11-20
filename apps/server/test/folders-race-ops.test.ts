/**
 * Concurrency (part two): group deletion (transfer, delete-all), shared placement, structure transactions against each other.
 * Same approach as `folders-race.test.ts`: one side is held at a test hook inside its own transaction, the other is sent, and `waitForLockWaiters` confirms it really waits on a lock
 * (an **assertion**, not just waiting); after release the winner, error code and final DB state are asserted. Each group runs both orders; every case asserts there is no
 * 409 `server_busy` (40P01 becomes it via `isRetryableTxError`) and the data is consistent - except the delete-all vs creating-a-note-in-a-group-folder group, which really deadlocks and asserts that 40P01 maps to 409.
 * The multi-id permanent-delete groups follow trash-race: the test connection holds one note's row lock and the two sides queue behind it in turn (two notes whose heap order and created_at order are opposite to id order).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { FolderDeleteResultDto, FolderDto, NoteDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import { notes } from "../src/db/schema.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { folderRow, noteFolderCols, placementOf, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser, sharesOf, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

type Res = LightMyRequestResponse;
const GROUP_NAME = "研發組";

const transfer = (app: FastifyInstance, by: string, groupId: string, to: string) =>
  inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "transfer", transferTo: to });
const deleteAll = (app: FastifyInstance, by: string, groupId: string) => inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "delete" });
const createFolder = (app: FastifyInstance, by: string, body: { name: string; parentId: string } | { name: string; space: { kind: "group"; groupId: string } }) =>
  inject(app, "POST", "/api/folders", by, body);
const patchFolder = (app: FastifyInstance, by: string, id: string, body: { name?: string; parentId?: string | null }) => inject(app, "PATCH", `/api/folders/${id}`, by, body);
const delFolder = (app: FastifyInstance, by: string, id: string) => inject(app, "DELETE", `/api/folders/${id}`, by);
const place = (app: FastifyInstance, by: string, noteId: string, folderId: string | null) => inject(app, "PUT", `/api/notes/${noteId}/folder`, by, { folderId });
const revoke = (app: FastifyInstance, by: string, noteId: string, userId: string) => inject(app, "DELETE", `/api/notes/${noteId}/shares/${userId}`, by);
const trashNote = (app: FastifyInstance, by: string, noteId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const copy = (app: FastifyInstance, by: string, noteId: string, body: { folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/copy`, by, body);
const move = (app: FastifyInstance, by: string, noteId: string, body: { groupId: string; folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/move`, by, body);

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const errCode = (r: Res): string | undefined => (r.statusCode >= 400 ? (r.json() as { error?: { code?: string } }).error?.code : undefined);

function okJson<T>(r: Res, status: number): T {
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
}
function failed(r: Res, status: number, code: string): void {
  expect(r.statusCode, r.body).toBe(status);
  expect(errCode(r)).toBe(code);
}

/** One-shot test hooks (convention of `trash-race.test.ts`): the point registered by `hold` blocks the first time it fires, other firings pass straight through. */
class Seams {
  private readonly handlers = new Map<string, () => Promise<void>>();
  on(name: GroupRacePoint, fn: () => Promise<void>): void {
    this.handlers.set(name, fn);
  }
  async fire(name: GroupRacePoint): Promise<void> {
    const fn = this.handlers.get(name);
    if (!fn) return;
    this.handlers.delete(name);
    await fn();
  }
  /** Blocks at name: `entered` resolves on entering the hook, `open()` releases. */
  hold(name: GroupRacePoint): { entered: Promise<void>; open: () => void } {
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

/** Waits for the request to enter the hook; if it responds first (never reached the hook) it fails at once instead of waiting idly. */
async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** True if at least n connections are waiting on locks (within 5 s); false on timeout (the caller releases and cleans up first, then asserts). */
async function sawLockWaiters(pool: Pool, n: number): Promise<boolean> {
  try {
    await waitForLockWaiters(pool, n);
    return true;
  } catch {
    return false;
  }
}

/** No 409 server_busy (the mapping of 40P01/55P03) and no 5xx. A reversed lock order (e.g. the structure lock of creating a group folder queued before groups KS) turns red here as server_busy. */
function noBusy(...rs: Res[]): void {
  for (const r of rs) {
    expect(errCode(r), r.body).not.toBe("server_busy");
    expect(r.statusCode, r.body).toBeLessThan(500);
  }
}

interface Scene {
  ctx: CollabTestCtx;
  app: FastifyInstance;
  db: Db;
  pool: Pool;
  seams: Seams;
  /** Waits for every `releaseDeletingGate` to finish (release is fire-and-forget). */
  gatesSettled(): Promise<void>;
}

async function scene(): Promise<Scene> {
  const seams = new Seams();
  const ctx = await buildCollabTestApp({
    collabHooks: (server, log) => createCollabHooks(server, log),
    groupTestHook: seams.group,
    storageLockTimeoutMs: 20_000,
  });
  const rel = vi.spyOn(ctx.collab, "releaseDeletingGate");
  return {
    ctx, app: ctx.app, db: ctx.db, pool: ctx.db.$client, seams,
    gatesSettled: async () => {
      await Promise.all(rel.mock.results.map(r => r.value));
    },
  };
}

/**
 * first is held at point; second is sent; asserts second really waits on a lock and neither is server_busy/5xx. Returns the responses [first, second].
 * `holdSecondUntilFirstReplies`: after second gets the lock and reaches this hook, it waits until first has replied - first re-reads outside the lock after commit
 * to build its response, and second must not commit ahead of that re-read (that would make first occasionally answer 404). Same as `opFirst` in `trash-race-ops.test.ts`.
 */
async function race(
  s: Scene,
  point: GroupRacePoint,
  first: () => Promise<Res>,
  second: () => Promise<Res>,
  holdSecondUntilFirstReplies?: GroupRacePoint,
): Promise<[Res, Res]> {
  // Hooks are keyed by point name: one registered later on the same point overrides first's hold.
  if (holdSecondUntilFirstReplies === point) throw new Error(`holdSecondUntilFirstReplies 不能與 point 同為 ${point}`);
  const h = s.seams.hold(point);
  let replied!: () => void;
  const firstReplied = new Promise<void>(r => { replied = r; });
  if (holdSecondUntilFirstReplies !== undefined) s.seams.on(holdSecondUntilFirstReplies, () => firstReplied);
  const p1 = first().finally(() => replied());
  await entered(h.entered, p1);
  const p2 = second();
  const waited = await sawLockWaiters(s.pool, 1);
  h.open();
  const out: [Res, Res] = [await p1, await p2];
  expect(waited, "第二方在第一方持有的鎖上等（交錯有發生）").toBe(true);
  noBusy(...out);
  return out;
}

/** Whole-database invariants: no note or placement points at a nonexistent folder; live notes have no snapshot; parent/child and note/folder are in the same space; the folder tree has no cycle. */
async function expectConsistent(pool: Pool): Promise<void> {
  const { rows } = await pool.query<Record<string, number>>(`select
    (select count(*)::int from notes n where n.folder_id is not null and not exists (select 1 from folders f where f.id = n.folder_id)) as dangling,
    (select count(*)::int from note_placements p where not exists (select 1 from folders f where f.id = p.folder_id)) as dangling_pl,
    (select count(*)::int from notes where deleted_at is null and trash_folder_path is not null) as live_snap,
    (select count(*)::int from folders c join folders p on p.id = c.parent_id
      where (c.kind, c.owner_id, c.group_id) is distinct from (p.kind, p.owner_id, p.group_id)) as parent_child,
    (select count(*)::int from notes n join folders f on f.id = n.folder_id
      where not ((f.kind = 'personal' and f.owner_id is not distinct from n.owner_id) or (f.kind = 'group' and f.group_id is not distinct from n.group_id))) as note_folder`);
  expect(rows[0]).toEqual({ dangling: 0, dangling_pl: 0, live_snap: 0, parent_child: 0, note_folder: 0 });
  expect(await cycles(pool)).toBe(0);
}

/** Recursive CTE walks up from each folder (the `CYCLE` clause detects repeats); returns the number of paths that form a cycle. */
async function cycles(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`with recursive up(start_id, id, parent_id) as (
      select id, id, parent_id from folders
      union all
      select up.start_id, f.id, f.parent_id from up join folders f on f.id = up.parent_id
    ) cycle id set is_cycle using trail
    select count(*)::int as n from up where is_cycle`);
  return rows[0]!.n;
}

async function noteIn(s: Scene, owner: { ownerId: string } | { groupId: string }, folderId: string | null, title?: string): Promise<string> {
  const n = await seedNote(s.db, owner, title !== undefined ? { title } : {});
  if (folderId !== null) await setNoteFolder(s.pool, n.id, folderId);
  return n.id;
}

async function ownerOf(pool: Pool, noteId: string): Promise<{ owner_id: string | null; group_id: string | null } | undefined> {
  const { rows } = await pool.query<{ owner_id: string | null; group_id: string | null }>("select owner_id, group_id from notes where id = $1", [noteId]);
  return rows[0];
}
async function groupExists(pool: Pool, groupId: string): Promise<boolean> {
  return (await pool.query("select 1 from groups where id = $1", [groupId])).rowCount === 1;
}
async function personalRoots(pool: Pool, ownerId: string): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    "select id, name from folders where kind = 'personal' and owner_id = $1 and parent_id is null order by name, id",
    [ownerId],
  );
  return rows;
}
async function folderCountNamed(pool: Pool, name: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int as n from folders where name = $1", [name])).rows[0]!.n;
}

/** A group whose admins are q (initiator) and r (recipient). */
async function groupScene(s: Scene) {
  const [q, r] = [await seedUser(s.db), await seedUser(s.db)];
  const g = await seedGroup(s.db, GROUP_NAME, [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
  return { q: q.id, r: r.id, g: g.id };
}

/** The test connection holds one note's row lock; returns the release function. */
async function holdRow(pool: Pool, id: string): Promise<() => Promise<void>> {
  const client: PoolClient = await pool.connect();
  await client.query("begin");
  await client.query("select 1 from notes where id = $1 for update", [id]);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await client.query("rollback");
    client.release();
  };
}

/** holder holds rowId -> first queues on it (waiter count 1) -> second queues (2) -> release. Asserts both waits happened and neither is server_busy/5xx. */
async function queueBehind(s: Scene, rowId: string, first: () => Promise<Res>, second: () => Promise<Res>): Promise<[Res, Res]> {
  const release = await holdRow(s.pool, rowId);
  let p1: Promise<Res> | undefined;
  let p2: Promise<Res> | undefined;
  const waited: boolean[] = [];
  try {
    p1 = first();
    waited.push(await sawLockWaiters(s.pool, 1));
    p2 = second();
    waited.push(await sawLockWaiters(s.pool, 2));
  } finally {
    await release();
  }
  const out: [Res, Res] = [await p1, await p2!];
  expect(waited, "兩方依序排在測試連線持有的列鎖上").toEqual([true, true]);
  noBusy(...out);
  return out;
}

/**
 * Scenario of the group-trash multi-id cases: two trashed notes a < b (by id) in group folder F, but b was inserted first (earlier in heap order), has the smaller slug
 * and earlier created_at - old delete-all (no ORDER BY) and transfer (by created_at) both lock b first; permanent delete by id locks a first.
 */
async function lockOrderScene(s: Scene) {
  const t = await groupScene(s);
  const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
  const [a, b] = [randomUUID(), randomUUID()].sort() as [string, string];
  const now = Date.now();
  await s.db.insert(notes).values({ id: b, groupId: t.g, slug: "dl-1", folderId: F, createdAt: new Date(now - 60_000) });
  await s.db.insert(notes).values({ id: a, groupId: t.g, slug: "dl-2", folderId: F, createdAt: new Date(now) });
  // Moving to the trash is an UPDATE that writes new tuples: update b, then a, so the new versions keep b first in physical order.
  for (const id of [b, a]) {
    await s.pool.query(`update notes set deleted_at = now(), deleted_by = $2, trash_folder_path = '["F"]'::jsonb where id = $1`, [id, t.q]);
  }
  const { rows } = await s.pool.query<{ id: string }>("select id from notes where group_id = $1", [t.g]);
  expect(rows.map(r => r.id), "前提：不帶 ORDER BY 的掃描順序是 b、a").toEqual([b, a]);
  return { ...t, F, a, b };
}

describe("transfer vs multi-id permanent delete of group trash notes (locks by id)", () => {
  it("permanent delete first (queued on a): permanent delete 200 purged [a, b]; transfer 204, 0 notes transferred, F is still taken into the recipient's new top level", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [pr, dr] = await queueBehind(s, t.a, () => purge(s.app, t.q, [t.a, t.b]), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t.a, t.b], skipped: [] });
    expect(dr.statusCode, dr.body).toBe(204);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("transfer first (queued on b, already holds a): transfer 204, both notes become personal notes in the recipient's trash (still in F); permanent delete waits for a -> the initiator no longer has trash rights -> both skipped not_found", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [dr, pr] = await queueBehind(s, t.b, () => transfer(s.app, t.q, t.g, t.r), () => purge(s.app, t.q, [t.a, t.b]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [], skipped: [{ id: t.a, reason: "not_found" }, { id: t.b, reason: "not_found" }] });
    for (const id of [t.a, t.b]) {
      expect(await ownerOf(s.pool, id), id).toEqual({ owner_id: t.r, group_id: null });
      expect((await trashCols(s.pool, id))?.deleted_at, id).not.toBeNull();
      expect(await noteFolderCols(s.pool, id), id).toEqual({ folder_id: t.F, trash_folder_path: ["F"] });
    }
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null });
    await expectConsistent(s.pool);
  });
});

describe("delete-all vs multi-id permanent delete (heap order opposite to id order)", () => {
  it("permanent delete first (queued on a): permanent delete 200 purged [a, b]; delete-all 204, group and folders gone", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [pr, dr] = await queueBehind(s, t.a, () => purge(s.app, t.q, [t.a, t.b]), () => deleteAll(s.app, t.q, t.g));
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t.a, t.b], skipped: [] });
    expect(dr.statusCode, dr.body).toBe(204);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    await expectConsistent(s.pool);
  });

  it("delete-all first (queued on b, already holds a): delete-all 204; permanent delete waits for a -> both notes are gone -> both skipped not_found", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [dr, pr] = await queueBehind(s, t.b, () => deleteAll(s.app, t.q, t.g), () => purge(s.app, t.q, [t.a, t.b]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [], skipped: [{ id: t.a, reason: "not_found" }, { id: t.b, reason: "not_found" }] });
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    await expectConsistent(s.pool);
  });
});

describe("transfer vs creating a group folder", () => {
  it("transfer first (stopped at group-delete-locked, holds lockGroup, hasn't taken the structure lock yet): a request creating at the group root waits on groups KS -> after the transfer commits 404 group_not_found, no folder created", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const [dr, cr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () =>
      createFolder(s.app, t.q, { name: "S", space: { kind: "group", groupId: t.g } }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(cr, 404, "group_not_found");
    expect(await folderCountNamed(s.pool, "S")).toBe(0);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("transfer first, creating under group folder A: waits on groups KS -> 404 folder_not_found (arrives by folder id), no new folder under A", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const [dr, cr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () =>
      createFolder(s.app, t.q, { name: "S", parentId: A }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(cr, 404, "folder_not_found");
    expect(await folderCountNamed(s.pool, "S")).toBe(0);
    expect(await folderRow(s.pool, A)).toMatchObject({ kind: "personal", owner_id: t.r });
    await expectConsistent(s.pool);
  });

  it("create first (stopped at folder-structure-locked, holds groups KS and the structure lock): transfer waits on lockGroup -> create 201; the transfer sees it, and it ends up under the recipient's new top level", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const [cr, dr] = await race(s, "folder-structure-locked", () =>
      createFolder(s.app, t.q, { name: "S", space: { kind: "group", groupId: t.g } }), () => transfer(s.app, t.q, t.g, t.r));
    const S = okJson<FolderDto>(cr, 201).id;
    expect(dr.statusCode, dr.body).toBe(204);
    // The group had no folders: the new top level is created because the transfer saw S.
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, S)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null, parent_id: roots[0]!.id, name: "S" });
    await expectConsistent(s.pool);
  });
});

describe("transfer vs deleting a group folder", () => {
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const [F, G] = await seedFolderChain(s.db, { group: t.g }, ["F", "G"]);
    const a = await noteIn(s, { groupId: t.g }, F!);
    return { ...t, F: F!, G: G!, a };
  }

  it("transfer first (stopped at group-delete-locked): delete waits on groups KS -> 404 folder_not_found, nothing moved to the trash; the whole of F is under the recipient's new top level, a is live in F, gates released", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, fr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => delFolder(s.app, t.r, t.F));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    expect(await folderRow(s.pool, t.G)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: t.F });
    expect((await trashCols(s.pool, t.a))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.a)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: t.F, trash_folder_path: null });
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });

  it("delete first (stopped at folder-delete-notes-locked): transfer waits on lockGroup -> delete 200; after the transfer F is gone, a is in the trash and handed to the recipient, snapshot prefixed with the new top-level name", async () => {
    const s = await scene();
    const t = await setup(s);
    const [fr, dr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.r, t.F), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<FolderDeleteResultDto>(fr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(dr.statusCode, dr.body).toBe(204);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    expect(await folderRow(s.pool, t.G)).toBeUndefined();
    expect((await trashCols(s.pool, t.a))?.deleted_at).not.toBeNull();
    expect(await ownerOf(s.pool, t.a)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: null, trash_folder_path: [GROUP_NAME, "F"] });
    // The group has no folders any more; the new top level is created for the trashed note with a snapshot.
    expect((await personalRoots(s.pool, t.r)).map(f => f.name)).toEqual([GROUP_NAME]);
    await expectConsistent(s.pool);
  });

  it("group fully transferred after the delete's pre-read and gate opening, before the transaction: inside the transaction 404 folder_not_found, the recipient's F and a untouched, gates released", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("folder-delete-gated");
    const deleting = delFolder(s.app, t.r, t.F);
    await entered(h.entered, deleting);
    let dr: Res;
    try {
      dr = await transfer(s.app, t.q, t.g, t.r);
    } finally {
      h.open();
    }
    const fr = await deleting;
    noBusy(dr, fr);
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r });
    expect(await folderRow(s.pool, t.G)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: t.F });
    expect((await trashCols(s.pool, t.a))?.deleted_at).toBeNull();
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: t.F, trash_folder_path: null });
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("transfer vs restoring group trash notes (rebuild by path)", () => {
  /** tn is in the group trash, at root, snapshot ["F","X"]: F still exists, X is gone. */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
    const tn = await noteIn(s, { groupId: t.g }, null);
    await markTrashed(s.pool, tn, t.q);
    await setSnapshot(s.pool, tn, ["F", "X"]);
    return { ...t, F, tn };
  }

  it("restore first (stopped at note-restore-locked, holds groups KS, structure lock, note lock): transfer waits on lockGroup -> restore 200, X rebuilt under F; transfer takes F>X and tn together into the recipient's new top level", async () => {
    const s = await scene();
    const t = await setup(s);
    const rh = s.seams.hold("note-restore-locked");
    // After the transfer gets its locks it stops at the first slug candidate and waits for the restore's response (the re-read after commit) to finish - otherwise the re-read would race the transfer's commit.
    const th = s.seams.hold("group-transfer-slug-candidate");
    const restoring = restore(s.app, t.q, [t.tn]);
    await entered(rh.entered, restoring);
    const deleting = transfer(s.app, t.q, t.g, t.r);
    const waited = await sawLockWaiters(s.pool, 1);
    rh.open();
    let rr: Res;
    try {
      rr = await restoring;
    } finally {
      th.open();
    }
    const dr = await deleting;
    expect(waited, "轉移在還原持有的 groups KS 上等").toBe(true);
    noBusy(rr, dr);
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect(dr.statusCode, dr.body).toBe(204);
    expect((await trashCols(s.pool, t.tn))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    const leaf = (await noteFolderCols(s.pool, t.tn))!.folder_id!;
    const X = await folderRow(s.pool, leaf);
    expect(X).toMatchObject({ kind: "personal", owner_id: t.r, name: "X", parent_id: t.F });
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("transfer first (stopped at group-delete-locked), restored by another admin: restore waits on groups KS -> after the transfer no trash rights -> skipped not_found; tn in the recipient's trash, snapshot prefixed with the new top-level name", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => restore(s.app, t.q, [t.tn]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashRestoreResultDto>(rr, 200)).toEqual({ restored: [], skipped: [{ id: t.tn, reason: "not_found" }] });
    expect((await trashCols(s.pool, t.tn))?.deleted_at).not.toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: null, trash_folder_path: [GROUP_NAME, "F", "X"] });
    expect(await folderCountNamed(s.pool, "X")).toBe(0);
    await expectConsistent(s.pool);
  });

  it("transfer first, restored by the recipient: restore waits on groups KS -> after the transfer it is the recipient's personal note and its space isn't among the locks already taken -> not rebuilt, restored to the recipient's root", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => restore(s.app, t.r, [t.tn]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect((await trashCols(s.pool, t.tn))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await folderCountNamed(s.pool, "X")).toBe(0);
    expect((await personalRoots(s.pool, t.r)).map(f => f.name)).toEqual([GROUP_NAME]);
    await expectConsistent(s.pool);
  });
});

describe("transfer vs the recipient renaming a personal root folder (to the group name)", () => {
  /** The group has folder A (the transfer creates a new top level); the recipient's root has O 'Old'. The transfer is initiated by q and given to r (initiator != recipient). */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const O = (await seedFolder(s.db, { personal: t.r }, { name: "Old" })).id;
    return { ...t, A, O };
  }

  it("rename first (stopped at folder-structure-locked, holds the recipient's structure lock): transfer waits on the recipient's structure lock -> rename 200; the new top level is '研發組 (2)', A under it", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.r, t.O, { name: GROUP_NAME }), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<FolderDto>(nr, 200).name).toBe(GROUP_NAME);
    expect(dr.statusCode, dr.body).toBe(204);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME, `${GROUP_NAME} (2)`]);
    expect(roots[0]!.id).toBe(t.O);
    expect(await folderRow(s.pool, t.A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[1]!.id });
    await expectConsistent(s.pool);
  });

  it("transfer first (stopped at folder-structure-locked, holds the group and recipient structure locks): rename waits on the recipient's structure lock -> transfer 204, new top level '研發組'; rename 409 folder_name_taken, O still named Old", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, nr] = await race(s, "folder-structure-locked", () => transfer(s.app, t.q, t.g, t.r), () => patchFolder(s.app, t.r, t.O, { name: GROUP_NAME }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(nr, 409, "folder_name_taken");
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual(["Old", GROUP_NAME]);
    expect(roots[0]!.id).toBe(t.O);
    expect(await folderRow(s.pool, t.A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[1]!.id });
    await expectConsistent(s.pool);
  });
});

describe("delete-all vs deleting a group folder", () => {
  /** Group F>G; live note a in F, trashed note tg in G. */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const [F, G] = await seedFolderChain(s.db, { group: t.g }, ["F", "G"]);
    const a = await noteIn(s, { groupId: t.g }, F!);
    const tg = await noteIn(s, { groupId: t.g }, G!);
    await markTrashed(s.pool, tg, t.q);
    await setSnapshot(s.pool, tg, ["F", "G"]);
    return { ...t, F: F!, G: G!, a, tg };
  }

  it("delete-all first (stopped at group-delete-locked): deleting the folder waits on groups KS -> 404 folder_not_found; delete-all 204, group, folders and both notes gone", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, fr] = await race(s, "group-delete-locked", () => deleteAll(s.app, t.q, t.g), () => delFolder(s.app, t.q, t.F));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect([await folderRow(s.pool, t.F), await folderRow(s.pool, t.G)]).toEqual([undefined, undefined]);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.tg)]).toEqual([undefined, undefined]);
    await expectConsistent(s.pool);
  });

  it("delete the folder first (stopped at folder-delete-notes-locked): delete-all waits on lockGroup -> delete 200 (a goes to the trash, F>G deleted); delete-all 204, the two notes in the trash are deleted too", async () => {
    const s = await scene();
    const t = await setup(s);
    const [fr, dr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.q, t.F), () => deleteAll(s.app, t.q, t.g));
    expect(okJson<FolderDeleteResultDto>(fr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(dr.statusCode, dr.body).toBe(204);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect([await folderRow(s.pool, t.F), await folderRow(s.pool, t.G)]).toEqual([undefined, undefined]);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.tg)]).toEqual([undefined, undefined]);
    await expectConsistent(s.pool);
  });
});

describe("delete-all vs creating a note in a group folder (FK check order is as after a pg_dump restore)", () => {
  /**
   * Same-table RI triggers fire in name order (`RI_ConstraintTrigger_c_<oid>`). Recreating the group FK gives it a larger OID -> the INSERT checks the folder FK first
   * (pg_dump creates FKs by name, so this is the order after a restore). Only touches this case's database (one new database per case).
   */
  async function flipFkOrder(pool: Pool): Promise<void> {
    await pool.query(`alter table notes drop constraint notes_group_id_groups_id_fk;
      alter table notes add constraint notes_group_id_groups_id_fk foreign key (group_id) references groups(id) on delete restrict on update no action`);
    const { rows } = await pool.query<{ conname: string }>(`select c.conname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
      where t.tgrelid = 'notes'::regclass and t.tgisinternal and t.tgtype & 4 = 4 and c.conname in ('notes_folder_fk', 'notes_group_id_groups_id_fk')
      order by t.tgname`);
    expect(rows.map(r => r.conname), "前提：INSERT 先檢查資料夾 FK、再檢查群組 FK").toEqual(["notes_folder_fk", "notes_group_id_groups_id_fk"]);
  }

  for (const withContent of [false, true]) {
    it(`delete-all first (stopped at group-delete-locked)${withContent ? ", with content" : ""}: the INSERT holds F's KS and waits on groups KS, delete-all's CASCADE delete of F waits for the INSERT -> 40P01; the victim gets 409 server_busy, the other succeeds, the create side is never a 5xx`, async () => {
      const s = await scene();
      const t = await groupScene(s);
      const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
      await flipFkOrder(s.pool);
      const h = s.seams.hold("group-delete-locked");
      const pd = deleteAll(s.app, t.q, t.g);
      await entered(h.entered, pd);
      const pc = inject(s.app, "POST", "/api/notes", t.q, { groupId: t.g, folderId: F, ...(withContent ? { content: "hello" } : {}) });
      const waited = await sawLockWaiters(s.pool, 1);
      h.open();
      const [dr, cr] = [await pd, await pc];
      expect(waited, "建立在全刪持有的群組列鎖上等").toBe(true);
      expect(cr.statusCode, cr.body).toBeLessThan(500);
      expect(dr.statusCode, dr.body).toBeLessThan(500);
      if (errCode(cr) === "server_busy") {
        // Normal timing: the INSERT that started waiting first runs deadlock detection first and is the victim.
        expect(cr.statusCode, cr.body).toBe(409);
        expect(dr.statusCode, dr.body).toBe(204);
        expect(await groupExists(s.pool, t.g)).toBe(false);
        expect(await folderRow(s.pool, F)).toBeUndefined();
        expect((await s.pool.query("select 1 from notes where group_id = $1", [t.g])).rowCount).toBe(0);
      } else {
        // The INSERT's detection ran before the cycle formed -> delete-all is the victim and nothing was deleted.
        failed(dr, 409, "server_busy");
        const n = okJson<NoteDto>(cr, 201);
        expect(await noteFolderCols(s.pool, n.id)).toEqual({ folder_id: F, trash_folder_path: null });
        expect(await groupExists(s.pool, t.g)).toBe(true);
      }
      await expectConsistent(s.pool);
    });
  }
});

describe("shared placement vs share revocation (API version)", () => {
  /** Owner o shares n with editor e; e has her own private shared folder SE. */
  async function setup(s: Scene) {
    const [o, e] = [await seedUser(s.db), await seedUser(s.db)];
    const n = await noteIn(s, { ownerId: o.id }, null);
    await seedShare(s.db, n, e.id, "editor");
    const SE = (await seedFolder(s.db, { shared: e.id }, { name: "SE" })).id;
    return { o: o.id, e: e.id, n, SE };
  }

  it("placement first (stopped at note-folder-locked, re-judged inside the transaction, before the upsert): revoking the share doesn't lock notes and returns 204 at once -> release -> the placement hits the share FK -> 404 not_found, no placement row", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("note-folder-locked");
    const placing = place(s.app, t.e, t.n, t.SE);
    await entered(h.entered, placing);
    const revoking = revoke(s.app, t.o, t.n, t.e);
    let settled: string;
    try {
      settled = await waitForBlockedOrSettled(s.pool, revoking);
    } finally {
      h.open();
    }
    const [pr, rv] = [await placing, await revoking];
    expect(settled, "撤分享沒有等任何鎖").toBe("settled");
    noBusy(pr, rv);
    expect(rv.statusCode, rv.body).toBe(204);
    failed(pr, 404, "not_found");
    expect(await placementOf(s.pool, t.e, t.n)).toBeNull();
    expect(await sharesOf(s.db, t.n)).toEqual([]);
    await expectConsistent(s.pool);
  });

  it("revoke first (placement stopped at note-folder-authorized, after authorization outside the transaction): revoke 204 -> the placement's in-transaction re-judgement doesn't see the note -> 404 not_found, no placement row", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("note-folder-authorized");
    const placing = place(s.app, t.e, t.n, t.SE);
    await entered(h.entered, placing);
    let rv: Res;
    try {
      rv = await revoke(s.app, t.o, t.n, t.e);
    } finally {
      h.open();
    }
    const pr = await placing;
    noBusy(pr, rv);
    expect(rv.statusCode, rv.body).toBe(204);
    failed(pr, 404, "not_found");
    expect(await placementOf(s.pool, t.e, t.n)).toBeNull();
    await expectConsistent(s.pool);
  });
});

describe("moving folders vs moving folders (parent and child of each other)", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const A = (await seedFolder(s.db, { personal: u }, { name: "A" })).id;
    const B = (await seedFolder(s.db, { personal: u }, { name: "B" })).id;
    return { u, A, B };
  }

  it("A into B first (stopped at folder-structure-locked): B into A waits on the structure lock -> A 200 under B; B 409 folder_cycle, still at root; tree has no cycle", async () => {
    const s = await scene();
    const t = await setup(s);
    const [ar, br] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.A, { parentId: t.B }), () => patchFolder(s.app, t.u, t.B, { parentId: t.A }));
    expect(okJson<FolderDto>(ar, 200).parentId).toBe(t.B);
    failed(br, 409, "folder_cycle");
    expect((await folderRow(s.pool, t.A))?.parent_id).toBe(t.B);
    expect((await folderRow(s.pool, t.B))?.parent_id).toBeNull();
    await expectConsistent(s.pool);
  });

  it("B into A first: A into B waits on the structure lock -> B 200 under A; A 409 folder_cycle, still at root; tree has no cycle", async () => {
    const s = await scene();
    const t = await setup(s);
    const [br, ar] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.B, { parentId: t.A }), () => patchFolder(s.app, t.u, t.A, { parentId: t.B }));
    expect(okJson<FolderDto>(br, 200).parentId).toBe(t.A);
    failed(ar, 409, "folder_cycle");
    expect((await folderRow(s.pool, t.B))?.parent_id).toBe(t.A);
    expect((await folderRow(s.pool, t.A))?.parent_id).toBeNull();
    await expectConsistent(s.pool);
  });
});

describe("create vs create with the same name (lower() comparison)", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const P = (await seedFolder(s.db, { personal: u }, { name: "P" })).id;
    return { u, P };
  }
  async function childrenOf(pool: Pool, parentId: string): Promise<string[]> {
    return (await pool.query<{ name: string }>("select name from folders where parent_id = $1 order by name", [parentId])).rows.map(r => r.name);
  }

  for (const [first, second] of [["Docs", "docs"], ["docs", "Docs"]] as const) {
    it(`'${first}' first (stopped at folder-structure-locked): '${second}' waits on the structure lock -> '${first}' 201; '${second}' 409 folder_name_taken, only one under P`, async () => {
      const s = await scene();
      const t = await setup(s);
      const [r1, r2] = await race(s, "folder-structure-locked", () => createFolder(s.app, t.u, { name: first, parentId: t.P }), () =>
        createFolder(s.app, t.u, { name: second, parentId: t.P }));
      expect(okJson<FolderDto>(r1, 201).name).toBe(first);
      failed(r2, 409, "folder_name_taken");
      expect(await childrenOf(s.pool, t.P)).toEqual([first]);
      await expectConsistent(s.pool);
    });
  }
});

describe("rename vs restore rebuilding the same name by path", () => {
  /** Root O 'Old'; tn is in the trash, at root, snapshot ["Docs"] (the original folder is gone). */
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const O = (await seedFolder(s.db, { personal: u }, { name: "Old" })).id;
    const tn = await noteIn(s, { ownerId: u }, null);
    await markTrashed(s.pool, tn, u);
    await setSnapshot(s.pool, tn, ["Docs"]);
    return { u, O, tn };
  }

  it("restore first (stopped at note-restore-locked, holds the structure lock): rename waits on the structure lock -> restore 200, a new 'Docs' rebuilt; rename 409 folder_name_taken, O still named Old", async () => {
    const s = await scene();
    const t = await setup(s);
    const [rr, nr] = await race(s, "note-restore-locked", () => restore(s.app, t.u, [t.tn]), () => patchFolder(s.app, t.u, t.O, { name: "Docs" }));
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    failed(nr, 409, "folder_name_taken");
    const leaf = (await noteFolderCols(s.pool, t.tn))!.folder_id!;
    expect(leaf).not.toBe(t.O);
    expect(await folderRow(s.pool, leaf)).toMatchObject({ name: "Docs", parent_id: null, owner_id: t.u });
    expect((await personalRoots(s.pool, t.u)).map(f => f.name)).toEqual(["Docs", "Old"]);
    await expectConsistent(s.pool);
  });

  it("rename first (stopped at folder-structure-locked): restore waits on the structure lock -> rename 200 'DOCS'; restore merges into O via lower(), no new one created", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, rr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.O, { name: "DOCS" }), () => restore(s.app, t.u, [t.tn]));
    expect(okJson<FolderDto>(nr, 200).name).toBe("DOCS");
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: t.O, trash_folder_path: null });
    expect(await personalRoots(s.pool, t.u)).toEqual([{ id: t.O, name: "DOCS" }]);
    await expectConsistent(s.pool);
  });
});

describe("placement vs moving to the trash (same note)", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const F1 = (await seedFolder(s.db, { personal: u }, { name: "F1" })).id;
    const F2 = (await seedFolder(s.db, { personal: u }, { name: "F2" })).id;
    const n = await noteIn(s, { ownerId: u }, F1);
    return { u, F1, F2, n };
  }

  it("placement first (stopped at note-folder-locked, holds note FU): move to trash waits on the note lock -> placement 200; move 204, snapshot is the new position", async () => {
    const s = await scene();
    const t = await setup(s);
    // The move gets the note lock when the placement commits; it stops at note-trash-locked to wait for the placement's response to finish, so it doesn't race the placement's post-commit re-read.
    const [pr, tr] = await race(s, "note-folder-locked", () => place(s.app, t.u, t.n, t.F2), () => trashNote(s.app, t.u, t.n), "note-trash-locked");
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(t.F2);
    expect(tr.statusCode, tr.body).toBe(204);
    expect((await trashCols(s.pool, t.n))?.deleted_at).not.toBeNull();
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.F2, trash_folder_path: ["F2"] });
    await expectConsistent(s.pool);
  });

  it("move first (stopped at note-trash-locked): placement waits on the note lock -> move 204; placement 404 not_found, position and snapshot are the original", async () => {
    const s = await scene();
    const t = await setup(s);
    const [tr, pr] = await race(s, "note-trash-locked", () => trashNote(s.app, t.u, t.n), () => place(s.app, t.u, t.n, t.F2));
    expect(tr.statusCode, tr.body).toBe(204);
    failed(pr, 404, "not_found");
    expect((await trashCols(s.pool, t.n))?.deleted_at).not.toBeNull();
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.F1, trash_folder_path: ["F1"] });
    await expectConsistent(s.pool);
  });
});

describe("copy ('make a copy') vs moving the source into a group", () => {
  /** Admin u has note n in personal folder P; group folder GF. */
  async function setup(s: Scene) {
    const g = await sixRoleScene(s.db);
    const u = g.admin.id;
    const P = (await seedFolder(s.db, { personal: u }, { name: "P" })).id;
    const GF = (await seedFolder(s.db, { group: g.groupId }, { name: "GF" })).id;
    const title = `RNCM-${u.slice(0, 8)}`;
    const n = await noteIn(s, { ownerId: u }, P, title);
    return { u, groupId: g.groupId, P, GF, n, title };
  }
  async function copiesOf(pool: Pool, title: string, exceptId: string) {
    const { rows } = await pool.query<{ id: string; owner_id: string | null; group_id: string | null; folder_id: string | null }>(
      "select id, owner_id, group_id, folder_id from notes where title = $1 and id <> $2", [title, exceptId],
    );
    return rows;
  }

  it("copy first (stopped at note-copy-locked, holds P and source KS): move waits on source FU -> copy 201 in P; move 200 into GF", async () => {
    const s = await scene();
    const t = await setup(s);
    const [cr, mr] = await race(s, "note-copy-locked", () => copy(s.app, t.u, t.n, { folderId: t.P }), () => move(s.app, t.u, t.n, { groupId: t.groupId, folderId: t.GF }));
    const dup = okJson<NoteDto>(cr, 201);
    expect(dup.folderId).toBe(t.P);
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.GF);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.GF, trash_folder_path: null });
    expect(await copiesOf(s.pool, t.title, t.n)).toEqual([{ id: dup.id, owner_id: t.u, group_id: null, folder_id: t.P }]);
    await expectConsistent(s.pool);
  });

  it("move first (stopped at note-move-locked, holds source FU, groups KS, GF KS): copy waits on source KS -> move 200; copy 201, the copy is still in P (personal)", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, cr] = await race(s, "note-move-locked", () => move(s.app, t.u, t.n, { groupId: t.groupId, folderId: t.GF }), () => copy(s.app, t.u, t.n, { folderId: t.P }));
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.GF);
    const dup = okJson<NoteDto>(cr, 201);
    expect(dup.folderId).toBe(t.P);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    expect(await copiesOf(s.pool, t.title, t.n)).toEqual([{ id: dup.id, owner_id: t.u, group_id: null, folder_id: t.P }]);
    await expectConsistent(s.pool);
  });
});
