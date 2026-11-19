import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { FOLDER_DEPTH_MAX, type FolderPermissionsDto } from "@knotebook/shared";
import { createDb, type Db } from "../src/db/index.js";
import type { Tx } from "../src/db/tx.js";
import { folders, groupMembers, notes } from "../src/db/schema.js";
import type { GroupHookCtx, GroupRacePoint } from "../src/groups/test-hook.js";
import type { FolderSpace } from "../src/folders/space.js";
import {
  FOLDER_CTE_DEPTH_LIMIT, NOTES_FOLDER_ID, folderAncestorIdsSql, folderDepthSql, folderPathJsonSql, folderSpaceWhere, subtreeFolderIdsSql, subtreeHeightSql,
} from "../src/folders/sql.js";
import { listVisibleFolders, resolveFolderAccess } from "../src/folders/queries.js";
import { folderAccessInTx, lockFolderInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx, memberFlagsInTx } from "../src/folders/tx/lock.js";
import { freshDb } from "./helpers.js";
import { seedGroup, seedNote, seedRole, seedUser, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { sixRoleScene } from "./trash-helpers.js";
import { noteFolderCols, seedFolder, seedFolderChain, setNoteFolder } from "./folder-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS, SLOW_DEFAULT_LOCK_TIMEOUT_MS } from "./lock-timeout-bound.js";

/** The drizzle logger also logs transaction control statements - filter them out before counting SQL. */
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const loggedDb = (pool: Pool, queries: string[]) => drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
const ids = async (db: Db, inner: ReturnType<typeof subtreeFolderIdsSql>) =>
  (await db.execute<{ id: string }>(sql`select id from folders where id in (${inner})`)).rows.map(r => r.id).sort();
const scalar = async <T>(db: Db, expr: ReturnType<typeof sql>) => (await db.execute<{ v: T }>(sql`select ${expr} as v`)).rows[0]!.v;
const sorted = (...xs: string[]) => [...xs].sort();

/** Transaction A takes the lock with `lock` and holds until `fn` finishes (released even if an assertion in `fn` fails, so the lock-holding transaction doesn't hang teardown). */
async function whileHeld(db: Db, lock: (tx: Tx) => Promise<unknown>, fn: () => Promise<void>): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const done = db.transaction(async tx => {
    await lock(tx);
    locked();
    await gate;
  });
  await ready;
  try {
    await fn();
  } finally {
    release();
    await done;
  }
}
const holdSpaces = (spaces: readonly FolderSpace[]) => (tx: Tx) => lockFolderSpacesInTx(tx, spaces, { lockTimeoutMs: 5_000 });

describe("folder SQL fragments (folders/sql.ts)", () => {
  it("path: a note in a three-level A > B 'q' > C gets a root -> leaf array; in A gets [A]; root level NULL; the same expression works inside an UPDATE", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [a, , c] = await seedFolderChain(db, { personal: u.id }, ["A", 'B "q"', "C"]);
    const inC = await seedNote(db, { ownerId: u.id });
    const inA = await seedNote(db, { ownerId: u.id });
    const atRoot = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, inC.id, c!);
    await setNoteFolder(pool, inA.id, a!);
    const pathOf = async (noteId: string) =>
      (await db.select({ p: folderPathJsonSql(NOTES_FOLDER_ID()) }).from(notes).where(eq(notes.id, noteId)))[0]!.p;
    expect(await pathOf(inC.id)).toEqual(["A", 'B "q"', "C"]);
    expect(await pathOf(inA.id)).toEqual(["A"]);
    expect(await pathOf(atRoot.id)).toBeNull();

    await db.update(notes).set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) }).where(inArray(notes.id, [inC.id, inA.id, atRoot.id]));
    expect(await noteFolderCols(pool, inC.id)).toEqual({ folder_id: c, trash_folder_path: ["A", 'B "q"', "C"] });
    expect(await noteFolderCols(pool, inA.id)).toEqual({ folder_id: a, trash_folder_path: ["A"] });
    expect(await noteFolderCols(pool, atRoot.id)).toEqual({ folder_id: null, trash_folder_path: null });
  });

  it("subtree: R>{X>{Y}, Z} and another tree S>{S1} -> R is exactly {R,X,Y,Z}; X is exactly {X,Y}", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const sp = { personal: u.id };
    const [r, x, y] = await seedFolderChain(db, sp, ["R", "X", "Y"]);
    const z = await seedFolder(db, sp, { parentId: r!, name: "Z" });
    await seedFolderChain(db, sp, ["S", "S1"]);
    expect(await ids(db, subtreeFolderIdsSql(r!))).toEqual(sorted(r!, x!, y!, z.id));
    expect(await ids(db, subtreeFolderIdsSql(x!))).toEqual(sorted(x!, y!));
  });

  it("depth/height/ancestors: R depth 1, Y depth 3; R height 3, Y height 1; Y's ancestors {Y,X,R}", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const [r, x, y] = await seedFolderChain(db, { personal: u.id }, ["R", "X", "Y"]);
    await seedFolderChain(db, { personal: u.id }, ["S", "S1"]);
    expect(await scalar<number>(db, folderDepthSql(r!))).toBe(1);
    expect(await scalar<number>(db, folderDepthSql(y!))).toBe(3);
    expect(await scalar<number>(db, subtreeHeightSql(r!))).toBe(3);
    expect(await scalar<number>(db, subtreeHeightSql(y!))).toBe(1);
    expect(await ids(db, folderAncestorIdsSql(y!))).toEqual(sorted(y!, x!, r!));
  });

  it("recursion limit: a chain of exactly FOLDER_CTE_DEPTH_LIMIT levels is walked completely; with an artificial cycle every query ends within the limit (no hang under statement_timeout 2 s)", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const N = FOLDER_CTE_DEPTH_LIMIT;
    // The limit must be above the deepest normally reachable depth (FOLDER_DEPTH_MAX + 1: a transfer adds one new top level) so legitimate trees aren't truncated
    expect(N).toBeGreaterThan(FOLDER_DEPTH_MAX + 1);
    const bounded = async <T>(q: ReturnType<typeof sql>) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '2s'`);
      return (await tx.execute<{ v: T }>(q)).rows.map(r => r.v);
    });
    const count = (inner: ReturnType<typeof subtreeFolderIdsSql>) => sql`select count(*)::int as v from (${inner}) kf_t`;
    const pathSql = (noteId: string) => sql`select ${folderPathJsonSql(NOTES_FOLDER_ID())} as v from notes where notes.id = ${noteId}`;

    const names = Array.from({ length: N }, (_, i) => `L${i + 1}`);
    const chain = await seedFolderChain(db, { personal: u.id }, names);
    const leaf = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, leaf.id, chain[N - 1]!);
    expect(await bounded<string[]>(pathSql(leaf.id))).toEqual([names]);
    expect(await bounded<number>(sql`select ${folderDepthSql(chain[N - 1]!)} as v`)).toEqual([N]);
    expect(await bounded<number>(sql`select ${subtreeHeightSql(chain[0]!)} as v`)).toEqual([N]);
    expect(await bounded<number>(count(subtreeFolderIdsSql(chain[0]!)))).toEqual([N]);
    expect(await bounded<number>(count(folderAncestorIdsSql(chain[N - 1]!)))).toEqual([N]);

    // Cycle CA <-> CB (the DB doesn't prevent cycles; created by direct writes): every query stops at N levels
    const [ca, cb] = await seedFolderChain(db, { personal: u.id }, ["CA", "CB"]);
    await pool.query("update folders set parent_id = $2 where id = $1", [ca, cb]);
    const inCa = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, inCa.id, ca!);
    const cyclePath = Array.from({ length: N }, (_, i) => ((N - 1 - i) % 2 === 0 ? "CA" : "CB"));
    await expect(bounded<string[]>(pathSql(inCa.id))).resolves.toEqual([cyclePath]);
    await expect(bounded<number>(sql`select ${folderDepthSql(ca!)} as v`)).resolves.toEqual([N]);
    await expect(bounded<number>(sql`select ${subtreeHeightSql(ca!)} as v`)).resolves.toEqual([N]);
    await expect(bounded<number>(count(subtreeFolderIdsSql(ca!)))).resolves.toEqual([N]);
    await expect(bounded<number>(count(folderAncestorIdsSql(ca!)))).resolves.toEqual([N]);
  });

  it("rendering: the path subquery of a single-table UPDATE and a single-table SELECT both carry the table name on the outer column notes.folder_id", async () => {
    const { db } = await freshDb();
    const upd = db.update(notes).set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) }).where(eq(notes.id, randomUUID())).toSQL().sql;
    expect(upd).toContain('where f.id = "notes"."folder_id"');
    // A single-table SELECT is the shape where drizzle renders a directly passed column as bare "folder_id" (an UPDATE still carries the table name, as of 0.44).
    const sel = db.select({ p: folderPathJsonSql(NOTES_FOLDER_ID()) }).from(notes).toSQL().sql;
    expect(sel).toContain('where f.id = "notes"."folder_id"');
  });

  it("folderSpaceWhere: personal/shared/group each select only their own space's folders", async () => {
    const { db } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: u.id, role: "admin" }]);
    const up = await seedFolder(db, { personal: u.id });
    const us = await seedFolder(db, { shared: u.id });
    const vp = await seedFolder(db, { personal: v.id });
    const gf = await seedFolder(db, { group: g.id });
    await seedFolder(db, { group: g2.id });
    const pick = async (space: FolderSpace) => (await db.select({ id: folders.id }).from(folders).where(folderSpaceWhere(space))).map(r => r.id);
    expect(await pick({ kind: "personal", ownerId: u.id })).toEqual([up.id]);
    expect(await pick({ kind: "shared", ownerId: u.id })).toEqual([us.id]);
    expect(await pick({ kind: "personal", ownerId: v.id })).toEqual([vp.id]);
    expect(await pick({ kind: "group", groupId: g.id })).toEqual([gf.id]);
  });
});

describe("folder visibility (folders/queries.ts, folders/tx/lock.ts)", () => {
  it("visibility: group folders derive permissions from the role; all-false roles and outsider -> null; personal/shared only for the owner; random uuid and non-UUID -> null; same derivation inside a transaction", async () => {
    const { db } = await freshDb();
    const s = await sixRoleScene(db);
    const noRead = await seedUser(db);
    const noReadRole = await seedRole(db, s.groupId, "nothing", {});
    await db.insert(groupMembers).values({ groupId: s.groupId, userId: noRead.id, roleId: noReadRole });
    const gf = await seedFolder(db, { group: s.groupId });
    const pf = await seedFolder(db, { personal: s.admin.id });
    const sf = await seedFolder(db, { shared: s.admin.id });

    const P = (manage: boolean, deleteNotes: boolean, createNote: boolean): FolderPermissionsDto => ({ manage, deleteNotes, createNote });
    const expected: Array<[string, string, FolderPermissionsDto | null]> = [
      ["admin", s.admin.id, P(true, true, true)],
      ["member", s.member.id, P(true, false, true)],
      ["editDelete", s.editDelete.id, P(true, true, false)],
      ["deleteOnly", s.deleteOnly.id, P(false, true, false)],
      ["editOnly", s.editOnly.id, P(true, false, false)],
      ["readOnly", s.readOnly.id, P(false, false, false)],
      ["noRead", noRead.id, null],
      ["outsider", s.outsider.id, null],
    ];
    const [gfRow] = await db.select().from(folders).where(eq(folders.id, gf.id));
    for (const [name, userId, perms] of expected) {
      const access = await resolveFolderAccess(db, userId, gf.id);
      expect(access?.permissions ?? null, name).toEqual(perms);
      if (access) {
        expect(access.folder.id, name).toBe(gf.id);
        expect(access.space, name).toEqual({ kind: "group", groupId: s.groupId });
      }
      const inTx = await db.transaction(tx => folderAccessInTx(tx, userId, gfRow!));
      expect(inTx, `${name}（交易內）`).toEqual(access);
    }
    expect((await resolveFolderAccess(db, s.admin.id, pf.id))?.permissions).toEqual(P(true, true, true));
    expect(await resolveFolderAccess(db, s.member.id, pf.id)).toBeNull();
    expect((await resolveFolderAccess(db, s.admin.id, sf.id))?.permissions).toEqual(P(true, true, false));
    expect(await resolveFolderAccess(db, s.member.id, sf.id)).toBeNull();
    const [pfRow] = await db.select().from(folders).where(eq(folders.id, pf.id));
    expect((await db.transaction(tx => folderAccessInTx(tx, s.admin.id, pfRow!)))?.permissions).toEqual(P(true, true, true));
    expect(await db.transaction(tx => folderAccessInTx(tx, s.member.id, pfRow!))).toBeNull();
    expect(await resolveFolderAccess(db, s.admin.id, randomUUID())).toBeNull();
    await expect(resolveFolderAccess(db, s.admin.id, "x")).resolves.toBeNull();

    // A site admin has no privilege: non-members can't see group folders or others' personal/shared, and their list is empty too
    const siteAdmin = await seedUser(db, { isAdmin: true });
    for (const f of [gf, pf, sf]) expect(await resolveFolderAccess(db, siteAdmin.id, f.id), f.name).toBeNull();
    expect(await db.transaction(tx => folderAccessInTx(tx, siteAdmin.id, gfRow!))).toBeNull();
    expect(await listVisibleFolders(db, siteAdmin.id)).toEqual([]);

    // memberFlagsInTx: members get four flags, non-members null
    expect(await db.transaction(tx => memberFlagsInTx(tx, s.member.id, s.groupId))).toEqual({ canRead: true, canCreate: true, canEdit: true, canDelete: false });
    expect(await db.transaction(tx => memberFlagsInTx(tx, s.outsider.id, s.groupId))).toBeNull();
  });

  it("list: only my personal, shared and the group folders I can read; order kind -> space -> root level first -> lower(name) -> id; permissions per row; createdAt ISO", async () => {
    const { db } = await freshDb();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const gMine = await seedGroup(db, "Mine", [{ userId: me.id, role: "admin" }, { userId: other.id, role: "member" }]);
    const gReadOnly = await seedGroup(db, "RO", [{ userId: other.id, role: "admin" }]);
    const roRole = await seedRole(db, gReadOnly.id, "ro", { canRead: true });
    await db.insert(groupMembers).values({ groupId: gReadOnly.id, userId: me.id, roleId: roRole });
    const gOthers = await seedGroup(db, "Others", [{ userId: other.id, role: "admin" }]);
    const gNoRead = await seedGroup(db, "NoRead", [{ userId: other.id, role: "admin" }]);
    const nrRole = await seedRole(db, gNoRead.id, "nr", {});
    await db.insert(groupMembers).values({ groupId: gNoRead.id, userId: me.id, roleId: nrRole });

    const mk = (space: Parameters<typeof seedFolder>[1], name: string, parentId?: string) =>
      seedFolder(db, space, { name, ...(parentId ? { parentId } : {}) });
    const pB = await mk({ personal: me.id }, "B1");
    const pA = await mk({ personal: me.id }, "a2");
    const pChild = await mk({ personal: me.id }, "0child", pB.id);
    const sh = await mk({ shared: me.id }, "shared");
    const gm1 = await mk({ group: gMine.id }, "zz");
    const gm0 = await mk({ group: gMine.id }, "Yy");
    const ro = await mk({ group: gReadOnly.id }, "ro");
    await mk({ group: gOthers.id }, "others");
    await mk({ group: gNoRead.id }, "noread");
    await mk({ personal: other.id }, "theirs");
    await mk({ shared: other.id }, "theirs-shared");

    const T = { manage: true, deleteNotes: true, createNote: true };
    const RO = { manage: false, deleteNotes: false, createNote: false };
    const SH = { manage: true, deleteNotes: true, createNote: false };
    const groupBlocks = [
      { gid: gMine.id, rows: [[gm0, null, T], [gm1, null, T]] as const },
      { gid: gReadOnly.id, rows: [[ro, null, RO]] as const },
    ].sort((x, y) => (x.gid < y.gid ? -1 : 1));
    const expected = [
      ...groupBlocks.flatMap(b => b.rows.map(([f, parentId, permissions]) => ({ id: f.id, name: f.name, parentId, space: { kind: "group", groupId: b.gid }, permissions }))),
      ...([[pA, null], [pB, null], [pChild, pB.id]] as const).map(([f, parentId]) => ({ id: f.id, name: f.name, parentId, space: { kind: "personal" }, permissions: T })),
      { id: sh.id, name: sh.name, parentId: null, space: { kind: "shared" }, permissions: SH },
    ];
    // resolves: if the SQL filter and folderAccessOf disagree listVisibleFolders throws, which must surface here as an assertion failure
    await expect(listVisibleFolders(db, me.id).then(l => l.map(({ createdAt: _c, ...rest }) => rest))).resolves.toEqual(expected);
    const list = await listVisibleFolders(db, me.id);
    const created = new Map((await db.select({ id: folders.id, createdAt: folders.createdAt }).from(folders)).map(r => [r.id, r.createdAt.toISOString()]));
    for (const f of list) expect(f.createdAt, f.name).toBe(created.get(f.id));
  });

  it("lockFolderInTx: returns the whole row; nonexistent -> undefined; update blocks key share, key share doesn't block key share", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "F" });
    const row = await db.transaction(tx => lockFolderInTx(tx, f.id, "key share"));
    expect(row).toMatchObject({ id: f.id, kind: "personal", ownerId: u.id, groupId: null, parentId: null, name: "F" });
    expect(await db.transaction(tx => lockFolderInTx(tx, randomUUID(), "update"))).toBeUndefined();

    const ks = () => db.transaction(tx => lockFolderInTx(tx, f.id, "key share"));
    let b: Promise<unknown> = Promise.resolve();
    await whileHeld(db, tx => lockFolderInTx(tx, f.id, "update"), async () => {
      b = ks();
      expect(await waitForBlockedOrSettled(pool, b)).toBe("blocked");
    });
    await b;
    await whileHeld(db, tx => lockFolderInTx(tx, f.id, "key share"), async () => {
      expect(await waitForBlockedOrSettled(pool, ks())).toBe("settled");
    });
  });
});

describe("structure lock and groups KS (folders/tx/lock.ts)", () => {
  it("structure lock exclusion: different keys don't wait, the same key waits, an uppercase id in the same space also waits (keys are lowercased)", async () => {
    const { db, pool } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    const lockB = (spaces: readonly FolderSpace[]) => db.transaction(tx => lockFolderSpacesInTx(tx, spaces, { lockTimeoutMs: 5_000 }));
    let pending: Promise<unknown> = Promise.resolve();
    await whileHeld(db, holdSpaces([mine]), async () => {
      // Different keys (someone else's personal, own shared) -> no wait (tested first: no other lock waiter exists at this point)
      const otherKey = lockB([{ kind: "personal", ownerId: v.id }, { kind: "shared", ownerId: u.id }]);
      pending = otherKey;
      expect(await waitForBlockedOrSettled(pool, otherKey)).toBe("settled");
      await otherKey;
      pending = lockB([mine]);
      await waitForLockWaiters(pool, 1);
    });
    await pending;
    await whileHeld(db, holdSpaces([mine]), async () => {
      pending = lockB([{ kind: "personal", ownerId: u.id.toUpperCase() }]);
      expect(await waitForBlockedOrSettled(pool, pending)).toBe("blocked");
    });
    await pending;
  });

  it("timeout: A doesn't release, B's limit is 200 ms -> 55P03, and on the order of 200 ms (not the transaction's original limit)", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    await whileHeld(db, holdSpaces([mine]), async () => {
      const t0 = Date.now();
      // The transaction's original limit is first set to 60 s (the session default is 0 = wait forever): if the 200 ms wasn't applied it would wait the full 60 s for 55P03;
      // the 20 s wall-clock bound is far from both (see ./lock-timeout-bound.ts).
      const err = await db
        .transaction(async tx => {
          await tx.execute(sql.raw(`set local lock_timeout = '${SLOW_DEFAULT_LOCK_TIMEOUT_MS}ms'`));
          await lockFolderSpacesInTx(tx, [mine], { lockTimeoutMs: 200 });
        })
        .catch((e: unknown) => e);
      expect((err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code).toBe("55P03");
      expect(Date.now() - t0).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    });
  });

  it("lock_timeout covers only the lock-taking statements: inside the transaction and after commit the same connection returns to the database-level 7s (not a hard-coded 0, not session-level)", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    // The database level is set to 7s (`TO DEFAULT` must return to this value); only newly opened connections pick it up, so a separate pool; max 1 => after commit the measurement is on the same connection
    const dbName = (await db.$client.query<{ d: string }>("select current_database() as d")).rows[0]!.d;
    await db.$client.query(`alter database "${dbName}" set lock_timeout = '7s'`);
    const pool2 = new Pool({ connectionString: url, max: 1 });
    try {
      const db2 = createDb(pool2);
      const show = async () => String((await pool2.query<{ lock_timeout: string }>("show lock_timeout")).rows[0]!.lock_timeout);
      expect(await show()).toBe("7s");
      let inside = "";
      await db2.transaction(async tx => {
        await lockFolderSpacesInTx(tx, [{ kind: "personal", ownerId: u.id }, { kind: "group", groupId: g.id }], { lockTimeoutMs: 200 });
        inside = String((await tx.execute<{ lock_timeout: string }>(sql`show lock_timeout`)).rows[0]!.lock_timeout);
      });
      expect(inside).toBe("7s");
      expect(await show()).toBe("7s");
    } finally {
      await pool2.end();
      await db.$client.query(`alter database "${dbName}" reset lock_timeout`);
    }
  });

  it("lockTimeoutMs must be a positive integer (0/negative/fraction/NaN -> throw, not sent to PG); not validated and returned directly when the key list is empty", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(db.transaction(tx => lockFolderSpacesInTx(tx, [mine], { lockTimeoutMs: bad })), String(bad)).rejects.toThrow(/lockTimeoutMs/);
    }
    await expect(db.transaction(tx => lockFolderSpacesInTx(tx, [], { lockTimeoutMs: 0 }))).resolves.toBeUndefined();
  });

  it("test hook: called exactly once after all three keys (including one duplicate space) are taken, with ctx unchanged", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const calls: Array<{ point: GroupRacePoint; ctx: GroupHookCtx; stmts: number }> = [];
    const ctx: GroupHookCtx = { folderId: randomUUID(), groupId: g.id };
    await logged.transaction(tx => lockFolderSpacesInTx(tx, [{ kind: "group", groupId: g.id }, mine, { kind: "shared", ownerId: u.id }, mine], {
      lockTimeoutMs: 5_000,
      hook: async (point, c) => { calls.push({ point, ctx: c, stmts: queries.filter(q => !TXN_CONTROL.test(q.trim())).length }); },
      hookCtx: ctx,
    }));
    expect(calls).toEqual([{ point: "folder-structure-locked", ctx, stmts: 9 }]);
  });

  it("empty keys: 0 SQL statements, hook not called", async () => {
    const { pool } = await freshDb();
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const calls: GroupRacePoint[] = [];
    await logged.transaction(tx => lockFolderSpacesInTx(tx, [], {
      lockTimeoutMs: 5_000,
      hook: async point => { calls.push(point); },
      hookCtx: { folderId: randomUUID() },
    }));
    expect(queries.filter(q => !TXN_CONTROL.test(q.trim()))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("groups KS: returns the ids that actually exist; one statement, ordered by id, for key share; empty array 0 statements", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: u.id, role: "admin" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: u.id, role: "admin" }]);
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const got = await logged.transaction(tx => lockGroupsKeyShareInTx(tx, [g2.id, g1.id, randomUUID()]));
    expect(got).toEqual(new Set([g1.id, g2.id]));
    const stmts = queries.filter(q => !TXN_CONTROL.test(q.trim()));
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('order by "groups"."id"');
    expect(stmts[0]).toContain("for key share");

    queries.length = 0;
    expect(await logged.transaction(tx => lockGroupsKeyShareInTx(tx, []))).toEqual(new Set());
    expect(queries.filter(q => !TXN_CONTROL.test(q.trim()))).toEqual([]);
  });
});
