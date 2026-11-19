import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import type { FolderDto, FolderListDto, TrashRestoreResultDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { folderRow, noteFolderCols, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject, markTrashed, trashCols } from "./trash-helpers.js";
import {
  legacyDeleteGroupWithNotesInTx,
  legacyMoveNoteToGroupInTx,
  legacyRestoreNotesInTx,
  legacyTransferGroupInTx,
} from "./legacy-tx-fixtures.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// The default space-lock limit is set to 60 s in this file (product value 5000) so the wall-clock bound for "the injected short limit took effect" is far from both - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const CTRL_NAME = String.fromCharCode(1) + String.fromCharCode(2);

async function transfer(
  app: FastifyInstance,
  groupId: string,
  by: string,
  transferTo: string,
  acceptLanguage?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "DELETE",
    url: `/api/groups/${groupId}`,
    cookies: await cookieOf(by),
    ...(acceptLanguage !== undefined ? { headers: { "accept-language": acceptLanguage } } : {}),
    payload: { mode: "transfer", transferTo },
  });
}
async function transferOk(app: FastifyInstance, groupId: string, by: string, transferTo: string, acceptLanguage?: string): Promise<void> {
  const r = await transfer(app, groupId, by, transferTo, acceptLanguage);
  expect(r.statusCode, r.body).toBe(204);
}
const deleteAll = (app: FastifyInstance, groupId: string, by: string) => inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "delete" });

type FolderLite = { id: string; kind: string; owner_id: string | null; group_id: string | null; parent_id: string | null; name: string; created_by: string | null };
async function personalFolders(pool: Pool, ownerId: string): Promise<FolderLite[]> {
  const { rows } = await pool.query<FolderLite>(
    "select id, kind, owner_id, group_id, parent_id, name, created_by from folders where kind = 'personal' and owner_id = $1 order by id",
    [ownerId],
  );
  return rows;
}
async function rootsOf(pool: Pool, ownerId: string): Promise<FolderLite[]> {
  return (await personalFolders(pool, ownerId)).filter(f => f.parent_id === null);
}
async function groupFolderCount(pool: Pool, groupId: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int n from folders where group_id = $1", [groupId])).rows[0]!.n;
}
async function pathOf(pool: Pool, folderId: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = folderId;
  while (cur !== null) {
    const f = await folderRow(pool, cur);
    if (!f) throw new Error(`pathOf: ${cur} 不存在`);
    out.unshift(f.name);
    cur = f.parent_id;
  }
  return out;
}
/** The trigger guards only the row being written; this full-scans with SQL to cover the two invariants "parent and child in the same space" and "a note in the same space as its folder". */
async function spaceViolations(pool: Pool): Promise<{ parentChild: number; noteFolder: number }> {
  const parentChild = (await pool.query<{ n: number }>(
    `select count(*)::int n from folders c join folders p on p.id = c.parent_id
     where (c.kind, c.owner_id, c.group_id) is distinct from (p.kind, p.owner_id, p.group_id)`,
  )).rows[0]!.n;
  const noteFolder = (await pool.query<{ n: number }>(
    `select count(*)::int n from notes n join folders f on f.id = n.folder_id
     where not ((f.kind = 'personal' and f.owner_id is not distinct from n.owner_id) or (f.kind = 'group' and f.group_id is not distinct from n.group_id))`,
  )).rows[0]!.n;
  return { parentChild, noteFolder };
}
async function listFolders(app: FastifyInstance, userId: string): Promise<FolderDto[]> {
  const r = await inject(app, "GET", "/api/folders", userId);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as FolderListDto).folders;
}
async function trashedNote(db: Db, owner: { groupId: string } | { ownerId: string }, by: string, folderId: string | null, snapshot: string[] | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(db.$client, n.id, folderId);
  if (snapshot !== null) await setSnapshot(db.$client, n.id, snapshot);
  await markTrashed(db.$client, n.id, by);
  return n.id;
}
async function liveNote(db: Db, owner: { groupId: string } | { ownerId: string }, folderId: string | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(db.$client, n.id, folderId);
  return n.id;
}

describe("delete group - transfer: the whole folder tree is taken into the recipient's new top level", () => {
  it("happy path: the new top level '研發組' is at the recipient's root with the whole tree under it; the three kinds of note rows land in place; restoring a note with a snapshot afterwards rebuilds by path under the new top level; only the recipient can see the tree", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, q, m] = [await seedUser(db), await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "研發組", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const [A, B] = await seedFolderChain(db, { group: g.id }, ["A", "B"]);
    const C = (await seedFolder(db, { group: g.id }, { name: "C" })).id;
    const a = await liveNote(db, { groupId: g.id }, A!);
    const b = await liveNote(db, { groupId: g.id }, B!);
    const root = await liveNote(db, { groupId: g.id }, null);
    const ta = await trashedNote(db, { groupId: g.id }, q.id, A!, ["A"]);
    const tr = await trashedNote(db, { groupId: g.id }, q.id, null, null);
    const ts = await trashedNote(db, { groupId: g.id }, q.id, null, ["X", "Y"]);
    expect(await personalFolders(pool, r.id)).toEqual([]);

    await transferOk(app, g.id, q.id, r.id);

    const roots = await rootsOf(pool, r.id);
    expect(roots).toHaveLength(1);
    const top = roots[0]!;
    expect(top).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: null, name: "研發組", created_by: q.id });
    expect(await folderRow(pool, A!)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: top.id, name: "A" });
    expect(await folderRow(pool, B!)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: A, name: "B" });
    expect(await folderRow(pool, C)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: top.id, name: "C" });
    expect((await personalFolders(pool, r.id)).map(f => f.id).sort()).toEqual([top.id, A!, B!, C].sort());

    expect(await noteFolderCols(pool, a)).toEqual({ folder_id: A, trash_folder_path: null });
    expect(await noteFolderCols(pool, b)).toEqual({ folder_id: B, trash_folder_path: null });
    expect(await noteFolderCols(pool, root)).toEqual({ folder_id: top.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, tr)).toEqual({ folder_id: top.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, ta)).toEqual({ folder_id: A, trash_folder_path: ["A"] });
    expect(await noteFolderCols(pool, ts)).toEqual({ folder_id: null, trash_folder_path: ["研發組", "X", "Y"] });
    const owners = (await pool.query<{ owner_id: string | null; group_id: string | null }>(
      "select distinct owner_id, group_id from notes where id = any($1::uuid[])", [[a, b, root, ta, tr, ts]],
    )).rows;
    expect(owners).toEqual([{ owner_id: r.id, group_id: null }]);
    expect(await spaceViolations(pool)).toEqual({ parentChild: 0, noteFolder: 0 });

    const mine = await listFolders(app, r.id);
    expect(mine.map(f => ({ id: f.id, parentId: f.parentId, name: f.name, space: f.space })).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: top.id, parentId: null, name: "研發組", space: { kind: "personal" } },
        { id: A!, parentId: top.id, name: "A", space: { kind: "personal" } },
        { id: B!, parentId: A!, name: "B", space: { kind: "personal" } },
        { id: C, parentId: top.id, name: "C", space: { kind: "personal" } },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(await listFolders(app, m.id)).toEqual([]);
    expect(await listFolders(app, q.id)).toEqual([]);

    const res = await inject(app, "POST", "/api/trash/restore", r.id, { ids: [ts] });
    expect(res.statusCode, res.body).toBe(200);
    const restored = res.json() as TrashRestoreResultDto;
    expect(restored.skipped).toEqual([]);
    const leaf = (await noteFolderCols(pool, ts))!.folder_id;
    expect(leaf).not.toBeNull();
    expect(await pathOf(pool, leaf!)).toEqual(["研發組", "X", "Y"]);
    const x = (await folderRow(pool, leaf!))!.parent_id!;
    expect((await folderRow(pool, x))!.parent_id).toBe(top.id);
    expect(await rootsOf(pool, r.id)).toHaveLength(1);
  });

  it("bystanders: another group's folders, the recipient's existing personal and private shared folders, others' folders - kind/owner_id/group_id/parent_id all unchanged", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, u] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: r.id, role: "admin" }]);
    await seedFolderChain(db, { group: g.id }, ["GA", "GB"]);
    const [HA, HB] = await seedFolderChain(db, { group: h.id }, ["HA", "HB"]);
    const hn = await liveNote(db, { groupId: h.id }, HB!);
    const RA = (await seedFolder(db, { personal: r.id }, { name: "Mine" })).id;
    const RS = (await seedFolder(db, { shared: r.id }, { name: "Shared" })).id;
    const [UA, UB] = await seedFolderChain(db, { personal: u.id }, ["UA", "UB"]);
    const watched = [HA!, HB!, RA, RS, UA!, UB!];
    const before = await Promise.all(watched.map(id => folderRow(pool, id)));

    await transferOk(app, g.id, r.id, r.id);

    expect(await Promise.all(watched.map(id => folderRow(pool, id)))).toEqual(before);
    expect(await groupFolderCount(pool, h.id)).toBe(2);
    expect(await noteFolderCols(pool, hn)).toEqual({ folder_id: HB, trash_folder_path: null });
    expect((await rootsOf(pool, r.id)).map(f => f.name).sort()).toEqual(["G", "Mine"]);
  });

  it("no structure: no folders and no trashed notes with a snapshot -> no new top level, notes at root; only trashed notes with a snapshot -> new top level created, root-level live notes go in too, snapshot prefixed", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const RA = (await seedFolder(db, { personal: r.id }, { name: "Mine" })).id;

    const g1 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const live1 = await liveNote(db, { groupId: g1.id }, null);
    const trashed1 = await trashedNote(db, { groupId: g1.id }, r.id, null, null);
    await transferOk(app, g1.id, r.id, r.id);
    expect((await personalFolders(pool, r.id)).map(f => f.id)).toEqual([RA]);
    expect(await noteFolderCols(pool, live1)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await noteFolderCols(pool, trashed1)).toEqual({ folder_id: null, trash_folder_path: null });

    const g2 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const live2 = await liveNote(db, { groupId: g2.id }, null);
    const snap = await trashedNote(db, { groupId: g2.id }, r.id, null, ["X"]);
    await transferOk(app, g2.id, r.id, r.id);
    const tops = (await rootsOf(pool, r.id)).filter(f => f.id !== RA);
    expect(tops.map(f => f.name)).toEqual(["研發組"]);
    expect(await noteFolderCols(pool, live2)).toEqual({ folder_id: tops[0]!.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, snap)).toEqual({ folder_id: null, trash_folder_path: ["研發組", "X"] });
  });

  it("live notes with a leftover snapshot (restored by old code during a rollback) don't count as trashed-with-snapshot: a group without folders gets no new top level for them, they stay at root, snapshot untouched; a group with folders puts them into the new top level by the root rule, snapshot untouched", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);

    const g1 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const stale1 = await liveNote(db, { groupId: g1.id }, null);
    await setSnapshot(pool, stale1, ["X"]);
    await transferOk(app, g1.id, r.id, r.id);
    expect(await personalFolders(pool, r.id)).toEqual([]);
    expect(await noteFolderCols(pool, stale1)).toEqual({ folder_id: null, trash_folder_path: ["X"] });

    const g2 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g2.id }, { name: "A" });
    const stale2 = await liveNote(db, { groupId: g2.id }, null);
    await setSnapshot(pool, stale2, ["X"]);
    await transferOk(app, g2.id, r.id, r.id);
    const roots = await rootsOf(pool, r.id);
    expect(roots.map(f => f.name)).toEqual(["研發組"]);
    expect(await noteFolderCols(pool, stale2)).toEqual({ folder_id: roots[0]!.id, trash_folder_path: ["X"] });
  });

  it("name collision and suffix: root already has '研發組' -> '研發組 (2)', snapshot prefixed with '研發組 (2)'; another '研發組 (2)' -> '研發組 (3)'; existing team and group name Team -> Team (2) (lower comparison)", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const existing = (await seedFolder(db, { personal: r.id }, { name: "研發組" })).id;
    const before = await folderRow(pool, existing);

    const g = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const ts = await trashedNote(db, { groupId: g.id }, r.id, null, ["X"]);
    await transferOk(app, g.id, r.id, r.id);
    const top2 = (await rootsOf(pool, r.id)).find(f => f.name === "研發組 (2)");
    expect(top2).toBeDefined();
    expect((await folderRow(pool, A))!.parent_id).toBe(top2!.id);
    expect(await noteFolderCols(pool, ts)).toEqual({ folder_id: null, trash_folder_path: ["研發組 (2)", "X"] });
    expect(await folderRow(pool, existing)).toEqual(before);

    const g3 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g3.id }, { name: "A" });
    await transferOk(app, g3.id, r.id, r.id);
    expect((await rootsOf(pool, r.id)).map(f => f.name).sort()).toEqual(["研發組", "研發組 (2)", "研發組 (3)"]);

    const u = await seedUser(db);
    const team = (await seedFolder(db, { personal: u.id }, { name: "team" })).id;
    // Bystanders: same name but not in the recipient's personal root (private shared root, personal child level, others' personal root) - the probe must not count them.
    await seedFolder(db, { shared: u.id }, { name: "Team" });
    await seedFolder(db, { personal: u.id }, { name: "Team (2)", parentId: team });
    await seedFolder(db, { personal: (await seedUser(db)).id }, { name: "Team (2)" });
    const t = await seedGroup(db, "Team", [{ userId: u.id, role: "admin" }]);
    await seedFolder(db, { group: t.id }, { name: "A" });
    await transferOk(app, t.id, u.id, u.id);
    expect((await rootsOf(pool, u.id)).map(f => f.name).sort()).toEqual(["Team (2)", "team"]);
  });

  it("long name: group name of 80 characters, recipient already has the same name -> new top level <= 80 code points, ending with ' (2)'", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const long = "名".repeat(80);
    await seedFolder(db, { personal: r.id }, { name: long });
    const g = await seedGroup(db, long, [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g.id }, { name: "A" });
    await transferOk(app, g.id, r.id, r.id);
    const top = (await rootsOf(pool, r.id)).find(f => f.name !== long)!;
    expect(Array.from(top.name).length).toBeLessThanOrEqual(80);
    expect(top.name).toBe(`${"名".repeat(76)} (2)`);
  });

  it("fixed name: a group name of only control characters -> zh-TW gives the Chinese word for group, en-US gives 'Group', no header gives 'Group'; an NFD group name -> NFC new top-level name", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const cases: Array<[string | undefined, string]> = [["zh-TW,zh;q=0.9,en;q=0.8", "群組"], ["en-US,en;q=0.9", "Group"], [undefined, "Group"]];
    for (const [lang, expected] of cases) {
      const r = await seedUser(db);
      const g = await seedGroup(db, "tmp", [{ userId: r.id, role: "admin" }]);
      await pool.query("update groups set name = $2 where id = $1", [g.id, CTRL_NAME]);
      await seedFolder(db, { group: g.id }, { name: "A" });
      await transferOk(app, g.id, r.id, r.id, lang);
      expect((await rootsOf(pool, r.id)).map(f => f.name), String(lang)).toEqual([expected]);
    }

    const r = await seedUser(db);
    const g = await seedGroup(db, `Cafe${COMBINING_ACUTE}`, [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g.id }, { name: "A" });
    await transferOk(app, g.id, r.id, r.id, "zh-TW");
    expect((await rootsOf(pool, r.id)).map(f => f.name)).toEqual([`Caf${E_ACUTE}`]);
  });

  it("depth isn't blocked: group tree of 5 levels -> after transfer the recipient's tree is 6 levels, 204; the whole database has no parent/child or note/folder in different spaces; the deepest note's position unchanged", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, q] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "Deep", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
    const chain = await seedFolderChain(db, { group: g.id }, ["L1", "L2", "L3", "L4", "L5"]);
    const n = await liveNote(db, { groupId: g.id }, chain[4]!);
    await transferOk(app, g.id, q.id, r.id);
    expect(await spaceViolations(pool)).toEqual({ parentChild: 0, noteFolder: 0 });
    expect(await pathOf(pool, chain[4]!)).toEqual(["Deep", "L1", "L2", "L3", "L4", "L5"]);
    expect(await noteFolderCols(pool, n)).toEqual({ folder_id: chain[4], trash_folder_path: null });
  });
});

describe("delete group - delete all", () => {
  it("group folders and subfolders are gone; other groups' folders and notes untouched", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: r.id, role: "admin" }]);
    const [A, B] = await seedFolderChain(db, { group: g.id }, ["A", "B"]);
    await liveNote(db, { groupId: g.id }, B!);
    const [HA] = await seedFolderChain(db, { group: h.id }, ["HA"]);
    const hn = await liveNote(db, { groupId: h.id }, HA!);
    const hBefore = await folderRow(pool, HA!);

    const res = await deleteAll(app, g.id, r.id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await folderRow(pool, A!)).toBeUndefined();
    expect(await folderRow(pool, B!)).toBeUndefined();
    expect(await groupFolderCount(pool, g.id)).toBe(0);
    expect(await folderRow(pool, HA!)).toEqual(hBefore);
    expect(await noteFolderCols(pool, hn)).toEqual({ folder_id: HA, trash_folder_path: null });
  });
});

describe("delete group: structure lock waits too long -> 409 server_busy", () => {
  /** Another connection holds the structure lock for key while act runs; `try { rollback } finally { release }`. */
  async function whileHolding<T>(pool: Pool, key: string, act: () => Promise<T>): Promise<T> {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
      return await act();
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
  }
  async function busy(res: Promise<LightMyRequestResponse>): Promise<void> {
    const t0 = Date.now();
    const r = await res;
    const ms = Date.now() - t0;
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
    expect(ms).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS); // the injected value (300 ms) took effect, not this file's default 60 s
  }
  const groupExists = async (pool: Pool, id: string) => (await pool.query("select 1 from groups where id = $1", [id])).rowCount === 1;

  it("transfer (another admin q initiates, giving to r): the group space lock and recipient r's personal space lock are each held (lock_timeout 300 ms) -> 409 server_busy (< 20 s), group and folders intact; 204 after release", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const [r, q] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "G", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const n = await liveNote(db, { groupId: g.id }, A);
    const before = await folderRow(pool, A);

    for (const key of [`knotebook.folders:group:${g.id}`, `knotebook.folders:personal:${r.id}`]) {
      await whileHolding(pool, key, () => busy(transfer(app, g.id, q.id, r.id)));
      expect(await groupExists(pool, g.id), key).toBe(true);
      expect(await folderRow(pool, A), key).toEqual(before);
      expect(await personalFolders(pool, r.id), key).toEqual([]);
      expect((await pool.query("select group_id from notes where id = $1", [n])).rows[0].group_id, key).toBe(g.id);
    }
    await transferOk(app, g.id, r.id, r.id);
  });

  it("delete all: the group space lock is held (lock_timeout 300 ms) -> 409 server_busy (< 20 s), group, folders and notes intact; 204 after release", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const r = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const n = await liveNote(db, { groupId: g.id }, A);

    await whileHolding(pool, `knotebook.folders:group:${g.id}`, () => busy(deleteAll(app, g.id, r.id)));
    expect(await groupExists(pool, g.id)).toBe(true);
    expect(await folderRow(pool, A)).toBeDefined();
    expect(await noteFolderCols(pool, n)).toEqual({ folder_id: A, trash_folder_path: null });
    const res = await deleteAll(app, g.id, r.id);
    expect(res.statusCode, res.body).toBe(204);
  });
});

describe("old-code compatibility: old transaction bodies (from before folders existed) run unchanged on the new schema", () => {
  it("old move-into-group, transfer, delete-all, restore all succeed; notes whose ownership changed get folder_id self-healed to NULL, group folders go with DELETE groups CASCADE, restore returns to the original folder or root", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const lockTimeoutMs = DEFAULT_STORAGE_LOCK_TIMEOUT_MS;

    // Move into group: a personal note in a personal folder -> group note, folder_id NULL (trigger self-heals)
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const PF = (await seedFolder(db, { personal: u.id })).id;
    const moved = await liveNote(db, { ownerId: u.id }, PF);
    await db.transaction(tx => legacyMoveNoteToGroupInTx(tx, { noteId: moved, userId: u.id, userHandle: u.handle, groupId: g.id, lockTimeoutMs }));
    expect((await pool.query("select owner_id, group_id, folder_id from notes where id = $1", [moved])).rows[0])
      .toEqual({ owner_id: null, group_id: g.id, folder_id: null });
    expect(await folderRow(pool, PF)).toBeDefined();

    // Transfer: live and trashed notes in a group folder -> the recipient's personal notes, folder_id NULL; group folders CASCADE
    const r = await seedUser(db);
    const g2 = await seedGroup(db, "G2", [{ userId: r.id, role: "admin" }]);
    const [GA, GB] = await seedFolderChain(db, { group: g2.id }, ["A", "B"]);
    const inB = await liveNote(db, { groupId: g2.id }, GB!);
    const trashedInA = await trashedNote(db, { groupId: g2.id }, r.id, GA!, ["A"]);
    await db.transaction(tx => legacyTransferGroupInTx(tx, { groupId: g2.id, transferTo: r.id, lockTimeoutMs }));
    for (const id of [inB, trashedInA]) {
      expect((await pool.query("select owner_id, group_id, folder_id from notes where id = $1", [id])).rows[0])
        .toEqual({ owner_id: r.id, group_id: null, folder_id: null });
    }
    expect(await folderRow(pool, GA!)).toBeUndefined();
    expect(await folderRow(pool, GB!)).toBeUndefined();
    expect(await personalFolders(pool, r.id)).toEqual([]);

    // Delete all: folders CASCADE, notes deleted
    const g3 = await seedGroup(db, "G3", [{ userId: r.id, role: "admin" }]);
    const [HA, HB] = await seedFolderChain(db, { group: g3.id }, ["A", "B"]);
    const doomed = await liveNote(db, { groupId: g3.id }, HB!);
    await db.transaction(tx => legacyDeleteGroupWithNotesInTx(tx, { groupId: g3.id }));
    expect(await folderRow(pool, HA!)).toBeUndefined();
    expect(await folderRow(pool, HB!)).toBeUndefined();
    expect(await noteFolderCols(pool, doomed)).toBeUndefined();

    // Restore: folder still exists -> back to the original folder, snapshot left over; folder already deleted -> root
    const keep = (await seedFolder(db, { personal: u.id }, { name: "Keep" })).id;
    const gone = (await seedFolder(db, { personal: u.id }, { name: "Gone" })).id;
    const back = await trashedNote(db, { ownerId: u.id }, u.id, keep, ["Keep"]);
    const orphan = await trashedNote(db, { ownerId: u.id }, u.id, gone, ["Gone"]);
    await pool.query("delete from folders where id = $1", [gone]);
    const out = await db.transaction(tx => legacyRestoreNotesInTx(tx, { ids: [back, orphan], by: u.id }));
    expect(out).toEqual({ done: [back, orphan], skipped: [] });
    expect(await noteFolderCols(pool, back)).toEqual({ folder_id: keep, trash_folder_path: ["Keep"] });
    expect(await noteFolderCols(pool, orphan)).toEqual({ folder_id: null, trash_folder_path: ["Gone"] });
    for (const id of [back, orphan]) expect((await trashCols(pool, id))?.deleted_at).toBeNull();
  });
});
