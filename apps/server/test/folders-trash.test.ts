/** Combining characters are always built with `String.fromCharCode`. */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { TrashItemDto, TrashListDto, TrashRestoreResultDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { restoreNotesInTx } from "../src/notes/tx/trash.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { listTrash } from "../src/trash/list.js";
import { folderRow, noteFolderCols, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// The default space-lock limit is set to 60 s in this file (product value 5000) so the wall-clock bound for "the injected short limit took effect" is far from both - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const ITEM_KEYS = ["deletedAt", "deletedBy", "folderPath", "group", "id", "purgeAt", "title"];

async function expect204(res: Promise<LightMyRequestResponse>): Promise<void> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(204);
}
const del = (app: FastifyInstance, noteId: string, userId: string) => expect204(inject(app, "DELETE", `/api/notes/${noteId}`, userId));
async function listOf(app: FastifyInstance, userId: string): Promise<TrashListDto> {
  const res = await inject(app, "GET", "/api/trash", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashListDto;
}
const itemOf = async (app: FastifyInstance, userId: string, noteId: string): Promise<TrashItemDto | undefined> =>
  (await listOf(app, userId)).items.find(i => i.id === noteId);
async function restore(app: FastifyInstance, userId: string, ids: string[]): Promise<TrashRestoreResultDto> {
  const res = await inject(app, "POST", "/api/trash/restore", userId, { ids });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashRestoreResultDto;
}

type FolderLite = { id: string; parent_id: string | null; name: string; kind: string; owner_id: string | null; group_id: string | null; created_by: string | null };
/** All folders of a space (created order isn't guaranteed; the caller finds its own). */
async function foldersOf(pool: Pool, space: { ownerId: string } | { groupId: string }): Promise<FolderLite[]> {
  const [col, id] = "ownerId" in space ? ["owner_id", space.ownerId] : ["group_id", space.groupId];
  const { rows } = await pool.query<FolderLite>(`select id, parent_id, name, kind, owner_id, group_id, created_by from folders where ${col} = $1`, [id]);
  return rows;
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

describe("folders and trash: move to trash and list", () => {
  it("move to trash writes the snapshot: the note in C keeps folder_id and gets snapshot [A,B,C]; the root note's snapshot is NULL; a live note of the same person in the same folder keeps NULL", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const [, , c] = await seedFolderChain(db, { personal: o.id }, ["A", "B", "C"]);
    const n = await seedNote(db, { ownerId: o.id });
    const root = await seedNote(db, { ownerId: o.id });
    const sibling = await seedNote(db, { ownerId: o.id });
    await setNoteFolder(pool, n.id, c!);
    await setNoteFolder(pool, sibling.id, c!);

    await del(app, n.id, o.id);
    await del(app, root.id, o.id);

    expect(await noteFolderCols(pool, n.id)).toEqual({ folder_id: c, trash_folder_path: ["A", "B", "C"] });
    expect(await noteFolderCols(pool, root.id)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await noteFolderCols(pool, sibling.id)).toEqual({ folder_id: c, trash_folder_path: null });
  });

  it("list folderPath: live path (follows renames), snapshot when the folder is gone, [] at root, group notes use the group folder; key set includes folderPath; the outer column of the live path carries the table name", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const [, b, c] = await seedFolderChain(db, { personal: o.id }, ["A", "B", "C"]);
    const n = await seedNote(db, { ownerId: o.id });
    const snap = await seedNote(db, { ownerId: o.id });
    const root = await seedNote(db, { ownerId: o.id });
    await setNoteFolder(pool, n.id, c!);
    for (const x of [n, snap, root]) await del(app, x.id, o.id);

    const item = await itemOf(app, o.id, n.id);
    expect(Object.keys(item!).sort()).toEqual(ITEM_KEYS);
    expect(Array.isArray(item!.folderPath)).toBe(true);
    expect(item!.folderPath).toEqual(["A", "B", "C"]);

    const renamed = await inject(app, "PATCH", `/api/folders/${b}`, o.id, { name: "B2" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await itemOf(app, o.id, n.id))!.folderPath).toEqual(["A", "B2", "C"]);
    expect((await noteFolderCols(pool, n.id))!.trash_folder_path).toEqual(["A", "B", "C"]);

    await setNoteFolder(pool, snap.id, null);
    await setSnapshot(pool, snap.id, ["X", "Y"]);
    expect((await itemOf(app, o.id, snap.id))!.folderPath).toEqual(["X", "Y"]);
    expect((await itemOf(app, o.id, root.id))!.folderPath).toEqual([]);

    const s = await sixRoleScene(db);
    const [, g2] = await seedFolderChain(db, { group: s.groupId }, ["G1", "G2"]);
    const gn = await seedNote(db, { groupId: s.groupId });
    await setNoteFolder(pool, gn.id, g2!);
    await del(app, gn.id, s.editDelete.id);
    expect((await itemOf(app, s.editDelete.id, gn.id))!.folderPath).toEqual(["G1", "G2"]);

    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    await listTrash(logged, o.id, 7);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(`where f.id = "notes"."folder_id"`);
    expect(queries[0]).toContain(`case when "notes"."folder_id" is not null`);
  });
});

describe("folders and trash: restore", () => {
  it("original folder still exists (B renamed to B2 meanwhile) -> back into C, no new one built from the old snapshot, snapshot cleared; response folderId = C; the other note not restored keeps its snapshot", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const [, b, c] = await seedFolderChain(db, { personal: o.id }, ["A", "B", "C"]);
    const n = await seedNote(db, { ownerId: o.id });
    const other = await seedNote(db, { ownerId: o.id });
    await setNoteFolder(pool, n.id, c!);
    await setNoteFolder(pool, other.id, c!);
    await del(app, n.id, o.id);
    await del(app, other.id, o.id);
    const renamed = await inject(app, "PATCH", `/api/folders/${b}`, o.id, { name: "B2" });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const out = await restore(app, o.id, [n.id]);
    expect(out.restored.map(r => [r.id, r.folderId])).toEqual([[n.id, c]]);
    expect(await noteFolderCols(pool, n.id)).toEqual({ folder_id: c, trash_folder_path: null });
    expect(await noteFolderCols(pool, other.id)).toEqual({ folder_id: c, trash_folder_path: ["A", "B", "C"] });
    expect(await foldersOf(pool, { ownerId: o.id })).toHaveLength(3);
  });

  it("original folder gone -> rebuilds three levels from the snapshot (created_by = the restorer); a second note with the same snapshot merges into the same chain; a bystander trash note's position unchanged; a same-named A in another space isn't reused", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const other = await seedUser(db);
    const othersA = await seedFolder(db, { personal: other.id }, { name: "A" });
    const sharedA = await seedFolder(db, { shared: o.id }, { name: "A" });
    const [p1, p2, bystander] = [await seedNote(db, { ownerId: o.id }), await seedNote(db, { ownerId: o.id }), await seedNote(db, { ownerId: o.id })];
    for (const x of [p1, p2, bystander]) {
      await markTrashed(pool, x.id, o.id);
      await setSnapshot(pool, x.id, ["A", "B", "C"]);
    }

    const out = await restore(app, o.id, [p1.id, p2.id]);
    const all = (await foldersOf(pool, { ownerId: o.id })).filter(f => f.kind === "personal");
    expect(all).toHaveLength(3);
    expect(all.every(f => f.created_by === o.id)).toBe(true);
    const leaf = (await noteFolderCols(pool, p1.id))!.folder_id!;
    expect(await pathOf(pool, leaf)).toEqual(["A", "B", "C"]);
    const rebuiltA = all.find(f => f.name === "A")!;
    expect(rebuiltA).toMatchObject({ kind: "personal", owner_id: o.id, parent_id: null });
    expect(rebuiltA.id).not.toBe(sharedA.id);
    const { rows: kids } = await pool.query("select id from folders where parent_id = any($1::uuid[])", [[othersA.id, sharedA.id]]);
    expect(kids).toEqual([]);
    expect(await noteFolderCols(pool, p1.id)).toEqual({ folder_id: leaf, trash_folder_path: null });
    expect(await noteFolderCols(pool, p2.id)).toEqual({ folder_id: leaf, trash_folder_path: null });
    expect(out.restored.map(r => r.folderId)).toEqual([leaf, leaf]);
    expect(await noteFolderCols(pool, bystander.id)).toEqual({ folder_id: null, trash_folder_path: ["A", "B", "C"] });
  });

  it("partially present, case and NFC: existing Docs, snapshot [docs, e + combining accent] -> reuses Docs, builds e-acute (NFC) under it; later [Docs, e-acute] merges into the same one", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const docs = await seedFolder(db, { personal: o.id }, { name: "Docs" });
    const [n1, n2] = [await seedNote(db, { ownerId: o.id }), await seedNote(db, { ownerId: o.id })];
    for (const x of [n1, n2]) await markTrashed(pool, x.id, o.id);
    await setSnapshot(pool, n1.id, ["docs", `e${COMBINING_ACUTE}`]);
    await setSnapshot(pool, n2.id, ["Docs", E_ACUTE]);

    await restore(app, o.id, [n1.id]);
    let all = await foldersOf(pool, { ownerId: o.id });
    expect(all.map(f => f.name).sort()).toEqual(["Docs", E_ACUTE]);
    const child = all.find(f => f.name === E_ACUTE)!;
    expect(child.parent_id).toBe(docs.id);
    expect((await noteFolderCols(pool, n1.id))!.folder_id).toBe(child.id);

    await restore(app, o.id, [n2.id]);
    all = await foldersOf(pool, { ownerId: o.id });
    expect(all).toHaveLength(2);
    expect((await noteFolderCols(pool, n2.id))!.folder_id).toBe(child.id);
  });

  it("not blocked by limits: a 7-level snapshot -> rebuilds 7 levels; a space that already has 1000 folders -> still rebuilds", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const deep = await seedNote(db, { ownerId: o.id });
    await markTrashed(pool, deep.id, o.id);
    const seven = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
    await setSnapshot(pool, deep.id, seven);
    await restore(app, o.id, [deep.id]);
    const leaf = (await noteFolderCols(pool, deep.id))!.folder_id!;
    expect(await pathOf(pool, leaf)).toEqual(seven);

    const v = await seedUser(db);
    await pool.query(
      `insert into folders (kind, owner_id, name, created_by) select 'personal', $1::uuid, 'F' || g, $1::uuid from generate_series(1, 1000) g`,
      [v.id],
    );
    const full = await seedNote(db, { ownerId: v.id });
    await markTrashed(pool, full.id, v.id);
    await setSnapshot(pool, full.id, ["New"]);
    await restore(app, v.id, [full.id]);
    expect(await foldersOf(pool, { ownerId: v.id })).toHaveLength(1001);
    expect(await pathOf(pool, (await noteFolderCols(pool, full.id))!.folder_id!)).toEqual(["New"]);
  });

  it("group note: editDelete restores (snapshot, folder gone) -> rebuilt in the group space", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool, gn.id, s.admin.id);
    await setSnapshot(pool, gn.id, ["GA", "GB"]);

    await restore(app, s.editDelete.id, [gn.id]);
    const all = await foldersOf(pool, { groupId: s.groupId });
    expect(all).toHaveLength(2);
    expect(all.every(f => f.kind === "group" && f.group_id === s.groupId && f.owner_id === null && f.created_by === s.editDelete.id)).toBe(true);
    const leaf = (await noteFolderCols(pool, gn.id))!.folder_id!;
    expect(await pathOf(pool, leaf)).toEqual(["GA", "GB"]);
  });

  it("no snapshot, folder_id NULL -> root, snapshot still NULL, no folder built; a snapshot that is an empty array or contains non-string segments (shapes that shouldn't occur) -> also stays at root, snapshot cleared", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const n = await seedNote(db, { ownerId: o.id });
    await del(app, n.id, o.id);
    const out = await restore(app, o.id, [n.id]);
    expect(out.restored[0]!.folderId).toBeNull();
    expect(await noteFolderCols(pool, n.id)).toEqual({ folder_id: null, trash_folder_path: null });

    const [empty, odd] = [await seedNote(db, { ownerId: o.id }), await seedNote(db, { ownerId: o.id })];
    for (const x of [empty, odd]) await markTrashed(pool, x.id, o.id);
    await setSnapshot(pool, empty.id, []);
    await setSnapshot(pool, odd.id, ["A", 1] as unknown as string[]);
    const out2 = await restore(app, o.id, [empty.id, odd.id]);
    expect(out2.restored.map(r => r.folderId)).toEqual([null, null]);
    for (const x of [empty, odd]) expect(await noteFolderCols(pool, x.id)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await foldersOf(pool, { ownerId: o.id })).toHaveLength(0);
  });

  it("lock order literally: groups FOR KEY SHARE -> structure lock -> notes FOR UPDATE", async () => {
    const { db, pool } = await freshDb();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "TRF9", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await markTrashed(pool, gn.id, admin.id);
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;

    const out = await logged.transaction(tx => restoreNotesInTx(tx, {
      ids: [gn.id], by: admin.id, groupIds: [g.id], spaces: [{ kind: "group", groupId: g.id }], lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS,
    }));
    expect(out).toEqual({ done: [gn.id], skipped: [] });
    const qs = queries.filter(q => !TXN_CONTROL.test(q.trim()));
    const groupsAt = qs.findIndex(q => /from "groups"/.test(q) && q.includes("for key share"));
    const advisoryAt = qs.findIndex(q => q.includes("pg_advisory_xact_lock"));
    const notesAt = qs.findIndex(q => /from "notes"/.test(q) && q.includes("for update"));
    expect(groupsAt).toBe(0);
    expect(advisoryAt).toBeGreaterThan(groupsAt);
    expect(notesAt).toBeGreaterThan(advisoryAt);
  });

  it("ownership changes after the pre-read: the group is transferred to the restorer after the pre-read -> restore 200, becomes his personal note, at root, no folder built in his space, snapshot cleared", async () => {
    let armed: { point: GroupRacePoint; fn: () => Promise<void> } | null = null;
    const hook = async (point: GroupRacePoint) => {
      if (armed && armed.point === point) {
        const { fn } = armed;
        armed = null;
        await fn();
      }
    };
    const { app, db } = await buildTestApp({ groupTestHook: hook });
    const pool = db.$client;
    const admin = await seedUser(db);
    const g = await seedGroup(db, "TRF10", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await markTrashed(pool, gn.id, admin.id);
    await setSnapshot(pool, gn.id, ["A", "B"]);

    let before = -1;
    armed = {
      point: "trash-restore-prejudged",
      fn: async () => {
        const res = await app.inject({
          method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
        });
        expect(res.statusCode, res.body).toBe(204);
        // The transfer itself may create a top level named after the group; that's the transfer's business, here only before vs after the restore is compared.
        before = (await foldersOf(pool, { ownerId: admin.id })).length;
      },
    };
    const out = await restore(app, admin.id, [gn.id]);
    expect(armed).toBeNull();
    expect(out.restored.map(r => [r.id, r.folderId])).toEqual([[gn.id, null]]);
    const { rows } = await pool.query("select owner_id, group_id, deleted_at from notes where id = $1", [gn.id]);
    expect(rows[0]).toEqual({ owner_id: admin.id, group_id: null, deleted_at: null });
    // Accepted known loss: a note transferred after the pre-read isn't rebuilt, and the snapshot prefix the transfer attached (["{group name}", ...]) is cleared too.
    expect(await noteFolderCols(pool, gn.id)).toEqual({ folder_id: null, trash_folder_path: null });
    expect((await foldersOf(pool, { ownerId: admin.id })).length).toBe(before);
  });

  it("structure lock waits too long (another connection holds the same space's lock, lock_timeout 300 ms): restore 409 server_busy (< 20 s: the injected value took effect, not this file's default 60 s), nothing changed; after the lock is released a retry rebuilds as usual", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const o = await seedUser(db);
    const n = await seedNote(db, { ownerId: o.id });
    await markTrashed(pool, n.id, o.id);
    await setSnapshot(pool, n.id, ["A", "B"]);
    const before = await trashCols(pool, n.id);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${o.id}`]);
      const t0 = Date.now();
      const res = await inject(app, "POST", "/api/trash/restore", o.id, { ids: [n.id] });
      const ms = Date.now() - t0;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
      expect(ms).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
    expect(await trashCols(pool, n.id)).toEqual(before);
    expect(await noteFolderCols(pool, n.id)).toEqual({ folder_id: null, trash_folder_path: ["A", "B"] });
    expect(await foldersOf(pool, { ownerId: o.id })).toHaveLength(0);

    const out = await restore(app, o.id, [n.id]);
    expect(out.restored.map(r => r.id)).toEqual([n.id]);
    const leaf = (await noteFolderCols(pool, n.id))!.folder_id!;
    expect(await pathOf(pool, leaf)).toEqual(["A", "B"]);
    expect(await noteFolderCols(pool, n.id)).toEqual({ folder_id: leaf, trash_folder_path: null });
  });
});
