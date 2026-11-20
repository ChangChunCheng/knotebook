/**
 * Concurrency (part one): deleting a folder against each operation. Runs on throwaway pg: one side is held at a test hook inside its own transaction,
 * the other is sent and `waitForLockWaiters` confirms it really waits on a lock; after release the result must be exactly the specified one. Each group runs both orders
 * (delete first and the other side first); every case asserts no 409 `server_busy` (40P01 becomes it via `isRetryableTxError`) and consistent data
 * (no note or placement pointing at a nonexistent folder, no live note with a snapshot).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import type { FolderDeleteResultDto, FolderDto, NoteDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { folderRow, noteFolderCols, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { seedNote, seedUser, waitForLockWaiters } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

type Res = LightMyRequestResponse;
const CHANGED = "The folder's contents just changed. Try again.";

const delFolder = (app: FastifyInstance, by: string, id: string) => inject(app, "DELETE", `/api/folders/${id}`, by);
const place = (app: FastifyInstance, by: string, noteId: string, folderId: string | null) => inject(app, "PUT", `/api/notes/${noteId}/folder`, by, { folderId });
const trashNote = (app: FastifyInstance, by: string, noteId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const createFolder = (app: FastifyInstance, by: string, parentId: string, name: string) => inject(app, "POST", "/api/folders", by, { name, parentId });
const patchFolder = (app: FastifyInstance, by: string, id: string, body: { name?: string; parentId?: string | null }) => inject(app, "PATCH", `/api/folders/${id}`, by, body);
const copy = (app: FastifyInstance, by: string, noteId: string, body: { folderId: string; groupId?: string }) => inject(app, "POST", `/api/notes/${noteId}/copy`, by, body);
const move = (app: FastifyInstance, by: string, noteId: string, body: { groupId: string; folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/move`, by, body);
const createNote = (app: FastifyInstance, by: string, body: { title: string; folderId: string; groupId?: string }) => inject(app, "POST", "/api/notes", by, body);

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
function conflicted(r: Res): void {
  failed(r, 409, "conflict");
  expect((r.json() as { error: { message: string } }).error.message).toBe(CHANGED);
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

/** Waits for n connections stuck on locks; on timeout releases first so the in-flight requests finish, then throws the timeout (no dangling requests). */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

/** No 409 server_busy (the mapping of 40P01/55P03) and no 5xx. A reversed lock order (e.g. a copy's folder KS queued after the source) turns red here as server_busy. */
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
 * first is held at point; second is sent and confirmed to be waiting on a lock; released. Returns the responses [first, second] and asserts neither is server_busy/5xx.
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
  await blockedOrBail(s.pool, 1, h.open, [p1, p2]);
  h.open();
  const out: [Res, Res] = [await p1, await p2];
  noBusy(...out);
  return out;
}

/** Whole-database invariants: no note or placement points at a nonexistent folder; live notes have no path snapshot. */
async function expectConsistent(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ dangling: number; dangling_pl: number; live_snap: number }>(`select
    (select count(*)::int from notes n where n.folder_id is not null and not exists (select 1 from folders f where f.id = n.folder_id)) as dangling,
    (select count(*)::int from note_placements p where not exists (select 1 from folders f where f.id = p.folder_id)) as dangling_pl,
    (select count(*)::int from notes where deleted_at is null and trash_folder_path is not null) as live_snap`);
  expect(rows[0]).toEqual({ dangling: 0, dangling_pl: 0, live_snap: 0 });
}

async function noteIn(s: Scene, owner: { ownerId: string } | { groupId: string }, folderId: string | null, title?: string): Promise<string> {
  const n = await seedNote(s.db, owner, title !== undefined ? { title } : {});
  if (folderId !== null) await setNoteFolder(s.pool, n.id, folderId);
  return n.id;
}

async function expectLiveAt(pool: Pool, noteId: string, folderId: string | null): Promise<void> {
  expect((await trashCols(pool, noteId))?.deleted_at, noteId).toBeNull();
  expect(await noteFolderCols(pool, noteId), noteId).toEqual({ folder_id: folderId, trash_folder_path: null });
}
async function expectTrashedWith(pool: Pool, noteId: string, path: string[]): Promise<void> {
  expect((await trashCols(pool, noteId))?.deleted_at, noteId).not.toBeNull();
  expect(await noteFolderCols(pool, noteId), noteId).toEqual({ folder_id: null, trash_folder_path: path });
}
async function expectFolders(pool: Pool, present: readonly string[], gone: readonly string[]): Promise<void> {
  for (const id of present) expect(await folderRow(pool, id), id).toBeDefined();
  for (const id of gone) expect(await folderRow(pool, id), id).toBeUndefined();
}

async function pathOf(pool: Pool, folderId: string): Promise<{ names: string[]; rootId: string }> {
  const names: string[] = [];
  let cur: string | null = folderId;
  let rootId = folderId;
  while (cur !== null) {
    const f = await folderRow(pool, cur);
    if (!f) throw new Error(`pathOf: ${cur} 不存在`);
    names.unshift(f.name);
    rootId = f.id;
    cur = f.parent_id;
  }
  return { names, rootId };
}

async function countTitled(pool: Pool, title: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from notes where title = $1", [title]);
  return rows[0]!.n;
}

/** Personal tree F>G (F at root), one live note a in F. */
async function personalTree(s: Scene) {
  const u = await seedUser(s.db);
  const [F, G] = await seedFolderChain(s.db, { personal: u.id }, ["F", "G"]);
  const a = await noteIn(s, { ownerId: u.id }, F!);
  return { u: u.id, F: F!, G: G!, a };
}

describe("delete folder vs placing into the subtree", () => {
  it("delete first: placement 404 folder_not_found, the note stays live at root; delete 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, null);
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, n, t.G));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(pr, 404, "folder_not_found");
    await expectLiveAt(s.pool, n, null);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectFolders(s.pool, [], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("placement first: placement 200; delete 409 conflict (the newly arrived live note has no gate opened), nothing deleted, all gates released", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, null);
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, t.G), () => delFolder(s.app, t.u, t.F));
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(t.G);
    conflicted(dr);
    await expectLiveAt(s.pool, n, t.G);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs placing out of the subtree", () => {
  it("delete first: placement waits on the note lock, after release that note is already in the trash -> 404 not_found; delete 200 includes it", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { name: "H" })).id;
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, t.a, H));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(pr, 404, "not_found");
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectFolders(s.pool, [H], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("placement first: delete re-evaluates the predicate and no longer locks it -> delete 200, trashedNoteIds doesn't contain it, its gate is taken back, the note is live at the new position", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const H = (await seedFolder(s.db, { personal: t.u }, { name: "H" })).id;
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, H), () => delFolder(s.app, t.u, t.F));
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(H);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    await expectLiveAt(s.pool, n, H);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(n)).toBe(false);
    expect(s.ctx.collab.isDeleting(t.a)).toBe(true);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs placement within the subtree", () => {
  it("delete first: placement 404 not_found (the note is already in the trash); delete 200, snapshot is the original position", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { parentId: t.F, name: "H" })).id;
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, n, H));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G, H]) });
    failed(pr, 404, "not_found");
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("placement first: placement 200; delete 200, the note goes to the trash together from another place in the subtree, snapshot is the new position", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { parentId: t.F, name: "H" })).id;
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    // After locking the subtree notes, the folder delete stops at folder-delete-notes-locked and waits for the placement's response to finish, so it doesn't race the placement's post-commit re-read
    // (folder delete calls `trashNotesInTx` without a hook, so note-trash-locked never fires).
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, H), () => delFolder(s.app, t.u, t.F), "folder-delete-notes-locked");
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(H);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G, H]) });
    await expectTrashedWith(s.pool, n, ["F", "H"]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs moving a single note to the trash", () => {
  it("delete first: move 404 not_found; delete 200 includes it", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [dr, tr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => trashNote(s.app, t.u, n));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(tr, 404, "not_found");
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("move first: move 204; delete 200, that note is in the trash group (not in trashedNoteIds), snapshot is the path at deletion time, folder_id cleared", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [tr, dr] = await race(s, "note-trash-locked", () => trashNote(s.app, t.u, n), () => delFolder(s.app, t.u, t.F));
    expect(tr.statusCode, tr.body).toBe(204);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs multi-id permanent delete (including a live id restored back into the subtree and a trashed id in the subtree)", () => {
  it("delete first: permanent delete waits on the note lock -> the two trashed notes are deleted, the restored live id is skipped; delete 200, trashedNoteIds doesn't contain the permanently deleted", async () => {
    const s = await scene();
    const t = await personalTree(s);
    // a is first moved to the trash then restored back into the subtree (a live id).
    await markTrashed(s.pool, t.a, t.u);
    await setSnapshot(s.pool, t.a, ["F"]);
    expect(okJson<TrashRestoreResultDto>(await restore(s.app, t.u, [t.a]), 200).restored.map(r => r.id)).toEqual([t.a]);
    await expectLiveAt(s.pool, t.a, t.F);
    const t1 = await noteIn(s, { ownerId: t.u }, t.F);
    const t2 = await noteIn(s, { ownerId: t.u }, t.G);
    for (const [id, path] of [[t1, ["F"]], [t2, ["F", "G"]]] as const) {
      await markTrashed(s.pool, id, t.u);
      await setSnapshot(s.pool, id, path);
    }
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => purge(s.app, t.u, [t.a, t2, t1]));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t2, t1], skipped: [{ id: t.a, reason: "not_found" }] });
    expect(await trashCols(s.pool, t1)).toBeUndefined();
    expect(await trashCols(s.pool, t2)).toBeUndefined();
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });

  it("permanent delete first (in the trash at pre-judgement, a live id restored back into the subtree by lock time): permanent delete 200 (live id not_in_trash, the trashed one deleted); delete 200 includes only the live one", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const tr = await noteIn(s, { ownerId: t.u }, t.G);
    for (const [id, path] of [[t.a, ["F"]], [tr, ["F", "G"]]] as const) {
      await markTrashed(s.pool, id, t.u);
      await setSnapshot(s.pool, id, path);
    }
    // Restore of a is held behind the lock -> permanent delete [a, tr] passes pre-judgement and waits for a's lock -> restore commits (a back in F) -> permanent delete locks the live a and tr, stuck -> delete of F waits.
    const rh = s.seams.hold("note-restore-locked");
    const ph = s.seams.hold("note-purge-locked");
    const restoring = restore(s.app, t.u, [t.a]);
    await entered(rh.entered, restoring);
    const purging = purge(s.app, t.u, [t.a, tr]);
    await blockedOrBail(s.pool, 1, rh.open, [restoring, purging]);
    rh.open();
    const rr = await restoring;
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(r => r.id)).toEqual([t.a]);
    await entered(ph.entered, purging);
    const deleting = delFolder(s.app, t.u, t.F);
    await blockedOrBail(s.pool, 1, ph.open, [purging, deleting]);
    ph.open();
    const [pr, dr] = [await purging, await deleting];
    noBusy(rr, pr, dr);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [tr], skipped: [{ id: t.a, reason: "not_in_trash" }] });
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(await trashCols(s.pool, tr)).toBeUndefined();
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs restore (rebuilt by path inside the subtree)", () => {
  /** r is in the trash, G of its original folder F>G is gone (folder_id NULL, snapshot ["F","G"]). */
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const r = await noteIn(s, { ownerId: t.u }, null);
    await markTrashed(s.pool, r, t.u);
    await setSnapshot(s.pool, r, ["F", "G"]);
    await s.pool.query("delete from folders where id = $1", [t.G]);
    return { ...t, r };
  }

  it("delete first: restore waits on the structure lock -> after the delete commits, rebuilds a new same-name path from the snapshot, the note lives on the new path", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => restore(s.app, t.u, [t.r]));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: [t.F] });
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.r]);
    const leaf = (await noteFolderCols(s.pool, t.r))!.folder_id!;
    await expectLiveAt(s.pool, t.r, leaf);
    const p = await pathOf(s.pool, leaf);
    expect(p.names).toEqual(["F", "G"]);
    expect(p.rootId).not.toBe(t.F);
    await expectFolders(s.pool, [], [t.F]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });

  it("restore first: restore rebuilds G inside F and commits; delete gets its lock and locks this live note with no gate opened -> 409 conflict, nothing deleted, all gates released", async () => {
    const s = await scene();
    const t = await setup(s);
    const [rr, dr] = await race(s, "note-restore-locked", () => restore(s.app, t.u, [t.r]), () => delFolder(s.app, t.u, t.F));
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.r]);
    conflicted(dr);
    const leaf = (await noteFolderCols(s.pool, t.r))!.folder_id!;
    await expectLiveAt(s.pool, t.r, leaf);
    expect(await pathOf(s.pool, leaf)).toEqual({ names: ["F", "G"], rootId: t.F });
    expect((await folderRow(s.pool, leaf))?.parent_id).toBe(t.F);
    await expectLiveAt(s.pool, t.a, t.F);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs creating a subfolder", () => {
  it("delete first: create 404 folder_not_found, no folder created; delete 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => createFolder(s.app, t.u, t.F, "S"));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(cr, 404, "folder_not_found");
    const { rows } = await s.pool.query<{ n: number }>("select count(*)::int as n from folders where owner_id = $1", [t.u]);
    expect(rows[0]!.n).toBe(0);
    await expectConsistent(s.pool);
  });

  it("create first: create 201; delete 200, the new subfolder is deleted too", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const [cr, dr] = await race(s, "folder-structure-locked", () => createFolder(s.app, t.u, t.F, "S"), () => delFolder(s.app, t.u, t.F));
    const S = okJson<FolderDto>(cr, 201).id;
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G, S]) });
    await expectFolders(s.pool, [], [t.F, t.G, S]);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs moving a subfolder (out of / into the subtree)", () => {
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const g = await noteIn(s, { ownerId: t.u }, t.G);
    const O = (await seedFolder(s.db, { personal: t.u }, { name: "O" })).id;
    return { ...t, g, O };
  }

  it("delete first: move 404 folder_not_found; delete 200 includes G and its notes", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.G, { parentId: t.O }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.g]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    await expectTrashedWith(s.pool, t.g, ["F", "G"]);
    await expectFolders(s.pool, [t.O], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("move first: move 200; delete 200, the moved-out subfolder and its notes are unaffected (the note's gate is taken back)", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.G, { parentId: t.O }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(mr, 200).parentId).toBe(t.O);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: [t.F] });
    expect((await folderRow(s.pool, t.G))?.parent_id).toBe(t.O);
    await expectLiveAt(s.pool, t.g, t.G);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.g)).toBe(false);
    await expectConsistent(s.pool);
  });

  it("move into the subtree, delete first: move 404 folder_not_found, X and its notes stay at root; delete 200 doesn't include them", async () => {
    const s = await scene();
    const t = await setup(s);
    const x = await noteIn(s, { ownerId: t.u }, t.O);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.O, { parentId: t.F }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.g]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    expect((await folderRow(s.pool, t.O))?.parent_id).toBeNull();
    await expectLiveAt(s.pool, x, t.O);
    await expectConsistent(s.pool);
  });

  it("move into the subtree, move first: move 200; delete 409 conflict (a whole extra tree whose live notes have no gate opened), nothing deleted, all gates released", async () => {
    const s = await scene();
    const t = await setup(s);
    const x = await noteIn(s, { ownerId: t.u }, t.O);
    const [mr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.O, { parentId: t.F }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(mr, 200).parentId).toBe(t.F);
    conflicted(dr);
    expect((await folderRow(s.pool, t.O))?.parent_id).toBe(t.F);
    await expectLiveAt(s.pool, x, t.O);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectLiveAt(s.pool, t.g, t.G);
    await expectFolders(s.pool, [t.F, t.G, t.O], []);
    await s.gatesSettled();
    for (const id of [t.a, t.g]) expect(s.ctx.collab.isDeleting(id), id).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs renaming a subfolder", () => {
  /** G has live note a2 and trashed note tr (snapshot has the old name). */
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const a2 = await noteIn(s, { ownerId: t.u }, t.G);
    const tr = await noteIn(s, { ownerId: t.u }, t.G);
    await markTrashed(s.pool, tr, t.u);
    await setSnapshot(s.pool, tr, ["F", "G"]);
    return { ...t, a2, tr };
  }

  it("delete first: rename 404 folder_not_found; delete 200, snapshot uses the old name", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, nr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.G, { name: "G2" }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.a2]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(nr, 404, "folder_not_found");
    await expectTrashedWith(s.pool, t.a2, ["F", "G"]);
    await expectTrashedWith(s.pool, t.tr, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("rename first: rename 200; delete 200, both the moved-in and the refreshed snapshots use the new name", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.G, { name: "G2" }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(nr, 200).name).toBe("G2");
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.a2]), deletedFolderIds: sorted([t.F, t.G]) });
    await expectTrashedWith(s.pool, t.a2, ["F", "G2"]);
    await expectTrashedWith(s.pool, t.tr, ["F", "G2"]);
    await expectConsistent(s.pool);
  });
});

describe("delete folder vs copying into the subtree", () => {
  interface CpForm {
    name: string;
    setup(s: Scene): Promise<{ by: string; F: string; G: string; others: string[]; src: string; srcAt: string | null; title: string; body: { folderId: string; groupId?: string } }>;
  }
  const forms: CpForm[] = [
    {
      name: "個人「建立副本」（來源與目標同一資料夾）",
      async setup(s) {
        const t = await personalTree(s);
        const title = `RFCP-p-${t.u.slice(0, 8)}`;
        const src = await noteIn(s, { ownerId: t.u }, t.G, title);
        return { by: t.u, F: t.F, G: t.G, others: [t.a], src, srcAt: t.G, title, body: { folderId: t.G } };
      },
    },
    {
      name: "群組「建立副本」",
      async setup(s) {
        const g = await sixRoleScene(s.db);
        const [F, G] = await seedFolderChain(s.db, { group: g.groupId }, ["F", "G"]);
        const a = await noteIn(s, { groupId: g.groupId }, F!);
        const title = `RFCP-g-${g.groupId.slice(0, 8)}`;
        const src = await noteIn(s, { groupId: g.groupId }, G!, title);
        return { by: g.admin.id, F: F!, G: G!, others: [a], src, srcAt: G!, title, body: { groupId: g.groupId, folderId: G! } };
      },
    },
    {
      name: "從子樹外複製進子樹",
      async setup(s) {
        const t = await personalTree(s);
        const title = `RFCP-o-${t.u.slice(0, 8)}`;
        const src = await noteIn(s, { ownerId: t.u }, null, title);
        return { by: t.u, F: t.F, G: t.G, others: [t.a], src, srcAt: null, title, body: { folderId: t.G } };
      },
    },
  ];

  for (const form of forms) {
    it(`${form.name}: delete first -> copy 404 folder_not_found, no copy created; delete 200`, async () => {
      const s = await scene();
      const c = await form.setup(s);
      const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, c.by, c.F), () => copy(s.app, c.by, c.src, c.body));
      const inTree = c.srcAt !== null ? [c.src] : [];
      expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([...c.others, ...inTree]), deletedFolderIds: sorted([c.F, c.G]) });
      failed(cr, 404, "folder_not_found");
      expect(await countTitled(s.pool, c.title)).toBe(1);
      await expectFolders(s.pool, [], [c.F, c.G]);
      await expectConsistent(s.pool);
    });

    it(`${form.name}: copy first -> copy 201 in G; delete 409 conflict, nothing deleted, all gates released`, async () => {
      const s = await scene();
      const c = await form.setup(s);
      // Stopped after the source KS (`note-copy-locked`): if the folder KS were queued after the source, only the source would be held here -> forms a cycle with the delete -> server_busy.
      const [cr, dr] = await race(s, "note-copy-locked", () => copy(s.app, c.by, c.src, c.body), () => delFolder(s.app, c.by, c.F));
      const dup = okJson<NoteDto>(cr, 201);
      expect(dup.folderId).toBe(c.G);
      conflicted(dr);
      await expectLiveAt(s.pool, dup.id, c.G);
      await expectLiveAt(s.pool, c.src, c.srcAt);
      for (const o of c.others) await expectLiveAt(s.pool, o, c.F);
      await expectFolders(s.pool, [c.F, c.G], []);
      await s.gatesSettled();
      for (const id of [...c.others, c.src]) expect(s.ctx.collab.isDeleting(id), id).toBe(false);
      await expectConsistent(s.pool);
    });
  }
});

describe("delete folder vs creating a note in a subtree folder (POST /api/notes, no transaction)", () => {
  it("delete first: the create's INSERT waits on the FK KS -> 23503 -> 404 folder_not_found, no note created; delete 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const title = `RFCN-${t.u.slice(0, 8)}`;
    const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => createNote(s.app, t.u, { title, folderId: t.G }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(cr, 404, "folder_not_found");
    expect(await countTitled(s.pool, title)).toBe(0);
    await expectConsistent(s.pool);
  });

  it("create first (the delete is stopped after its pre-read and gate opening; the create completes before the delete is released): create 201; delete 409 conflict, nothing deleted, all gates released", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const title = `RFCN-${t.u.slice(0, 8)}`;
    const h = s.seams.hold("folder-delete-gated");
    const deleting = delFolder(s.app, t.u, t.F);
    await entered(h.entered, deleting);
    let cr: Res;
    try {
      cr = await createNote(s.app, t.u, { title, folderId: t.G });
    } finally {
      h.open();
    }
    const dr = await deleting;
    noBusy(cr, dr);
    const created = okJson<NoteDto>(cr, 201);
    expect(created.folderId).toBe(t.G);
    conflicted(dr);
    await expectLiveAt(s.pool, created.id, t.G);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("delete group folder vs moving a personal note into a group subtree folder", () => {
  async function setup(s: Scene) {
    const g = await sixRoleScene(s.db);
    const [F, G] = await seedFolderChain(s.db, { group: g.groupId }, ["F", "G"]);
    const ga = await noteIn(s, { groupId: g.groupId }, F!);
    const n = await noteIn(s, { ownerId: g.admin.id }, null);
    return { by: g.admin.id, groupId: g.groupId, F: F!, G: G!, ga, n };
  }
  async function ownerOf(pool: Pool, noteId: string) {
    const { rows } = await pool.query<{ owner_id: string | null; group_id: string | null }>("select owner_id, group_id from notes where id = $1", [noteId]);
    return rows[0];
  }

  it("delete first: move 404 folder_not_found, the note is still at personal root; delete 200", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.by, t.F), () => move(s.app, t.by, t.n, { groupId: t.groupId, folderId: t.G }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.ga], deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: t.by, group_id: null });
    await expectLiveAt(s.pool, t.n, null);
    await expectTrashedWith(s.pool, t.ga, ["F"]);
    await expectConsistent(s.pool);
  });

  it("move first: move 200 into G; delete 409 conflict, nothing deleted, all gates released", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, dr] = await race(s, "note-move-locked", () => move(s.app, t.by, t.n, { groupId: t.groupId, folderId: t.G }), () => delFolder(s.app, t.by, t.F));
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.G);
    conflicted(dr);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    await expectLiveAt(s.pool, t.n, t.G);
    await expectLiveAt(s.pool, t.ga, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.ga)).toBe(false);
    await expectConsistent(s.pool);
  });
});
