// Every UPDATE/DELETE statement runs with bystander rows present (same owner's other note, someone else's note, another trashed note).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Y from "yjs";
import type { Db } from "../src/db/index.js";
import type { Tx } from "../src/db/tx.js";
import { noteStates, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { purgeExpiredBatchInTx, purgeTrashedNotesInTx, restoreNotesInTx, trashNotesInTx, type TrashRestoreInput } from "../src/notes/tx/trash.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { freshDb } from "./helpers.js";
import { noteState, seedNote, seedShare, seedUser, sharesOf, waitForBlockedOrSettled } from "./group-helpers.js";
import { markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

/** The drizzle logger also records transaction-control statements: filter them out before counting SQL. */
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;

async function seedUploadRow(db: Db, noteId: string, uploaderId: string): Promise<string> {
  const [u] = await db.insert(uploads).values({ noteId, uploaderId, mime: "image/png", size: 1 }).returning({ id: uploads.id });
  return u!.id;
}
const uploadIdsOf = async (db: Db, noteId: string) =>
  (await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, noteId))).map(r => r.id);
const exists = async (db: Db, noteId: string) => (await db.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId))).length === 1;

class Rollback extends Error {}
/** Run fn in a transaction, take its return value, then roll back (the same scenario can be run again with other parameters). */
async function rolledBack<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await expect(db.transaction(async tx => { out = await fn(tx); throw new Rollback(); })).rejects.toBeInstanceOf(Rollback);
  return out as T;
}

/** Restore input: no group and no spaces (takes no groups KS and no structure locks; the full lock order with folders is in `folders-trash.test.ts`). */
const restoreIn = (ids: readonly string[], by: string): TrashRestoreInput => ({ ids, by, groupIds: [], spaces: [], lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS });

/** Two uuids in descending order (the input order is deliberately opposite to ascending id). */
const desc = (...ids: string[]) => [...ids].sort().reverse();

describe("#181 trashNotesInTx", () => {
  it("move happy path: deleted_at = the same transaction's now(), deleted_by = operator; updated_at, shares, public fields, uploads, note_states untouched; bystanders untouched", async () => {
    const { db, pool } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedNote(db, { ownerId: u.id }, { publicToken: "a".repeat(43), publicSlug: "alias-t1" });
    const sibling = await seedNote(db, { ownerId: u.id });
    const others = await seedNote(db, { ownerId: v.id });
    await seedShare(db, n.id, v.id, "editor");
    const up = await seedUploadRow(db, n.id, u.id);
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    const before = await noteState(pool, n.id);

    const { outcome, same } = await db.transaction(async tx => {
      const outcome = await trashNotesInTx(tx, { ids: [n.id], by: u.id });
      const r = await tx.execute<{ same: boolean }>(sql`select deleted_at = now() as same from notes where id = ${n.id}`);
      return { outcome, same: r.rows[0]?.same };
    });

    expect(outcome).toEqual({ trashed: [n.id], notFound: [], forbidden: [] });
    expect(same).toBe(true);
    expect((await trashCols(pool, n.id))?.deleted_by).toBe(u.id);
    expect(await noteState(pool, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: v.id, role: "editor" }]);
    expect(await uploadIdsOf(db, n.id)).toEqual([up]);
    expect(await db.select({ id: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, n.id))).toHaveLength(1);
    expect(await trashCols(pool, sibling.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await trashCols(pool, others.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("permissions: group admin/editDelete/deleteOnly may move; member/editOnly/readOnly forbidden, outsider notFound; a personal note's shared editor forbidden, outsider notFound", async () => {
    const { db, pool } = await freshDb();
    const s = await sixRoleScene(db);
    const cases: Array<[string, string, "trashed" | "forbidden" | "notFound"]> = [
      ["admin", s.admin.id, "trashed"],
      ["editDelete", s.editDelete.id, "trashed"],
      ["deleteOnly", s.deleteOnly.id, "trashed"],
      ["member", s.member.id, "forbidden"],
      ["editOnly", s.editOnly.id, "forbidden"],
      ["readOnly", s.readOnly.id, "forbidden"],
      ["outsider", s.outsider.id, "notFound"],
    ];
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const [name, by, expected] of cases) {
      const gn = await seedNote(db, { groupId: s.groupId });
      const out = await db.transaction(tx => trashNotesInTx(tx, { ids: [gn.id], by }));
      got[name] = (Object.keys(out) as Array<keyof typeof out>).filter(k => out[k].includes(gn.id)).join(",");
      want[name] = expected;
      expect((await trashCols(pool, gn.id))?.deleted_at === null, name).toBe(expected !== "trashed");
    }
    expect(got).toEqual(want);

    const owner = await seedUser(db);
    const p = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, p.id, s.editOnly.id, "editor");
    expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [p.id], by: s.editOnly.id }))).toEqual({ trashed: [], notFound: [], forbidden: [p.id] });
    expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [p.id], by: s.outsider.id }))).toEqual({ trashed: [], notFound: [p.id], forbidden: [] });
    expect(await trashCols(pool, p.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("already in trash -> notFound, deleted_at/deleted_by not overwritten; random uuid -> notFound", async () => {
    const { db, pool } = await freshDb();
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId });
    expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [gn.id], by: s.editDelete.id }))).toEqual({ trashed: [gn.id], notFound: [], forbidden: [] });
    const first = await trashCols(pool, gn.id);
    expect(first?.deleted_by).toBe(s.editDelete.id);

    expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [gn.id], by: s.admin.id }))).toEqual({ trashed: [], notFound: [gn.id], forbidden: [] });
    expect(await trashCols(pool, gn.id)).toEqual(first);

    const missing = randomUUID();
    expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [missing], by: s.admin.id }))).toEqual({ trashed: [], notFound: [missing], forbidden: [] });
  });

  it("several notes (unsorted input) are classified individually; empty ids -> three empty arrays, no SQL issued", async () => {
    const { db, pool } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const ok1 = await seedNote(db, { ownerId: u.id });
    const ok2 = await seedNote(db, { ownerId: u.id });
    const forbidden1 = await seedNote(db, { ownerId: v.id });
    await seedShare(db, forbidden1.id, u.id, "editor");
    const missing = randomUUID();

    const out = await db.transaction(tx => trashNotesInTx(tx, { ids: [ok1.id, forbidden1.id, missing, ok2.id], by: u.id }));
    expect([...out.trashed].sort()).toEqual([ok1.id, ok2.id].sort());
    expect(out.forbidden).toEqual([forbidden1.id]);
    expect(out.notFound).toEqual([missing]);
    expect(await trashCols(pool, forbidden1.id)).toEqual({ deleted_at: null, deleted_by: null });

    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    expect(await logged.transaction(tx => trashNotesInTx(tx, { ids: [], by: u.id }))).toEqual({ trashed: [], notFound: [], forbidden: [] });
    expect(await logged.transaction(tx => restoreNotesInTx(tx, restoreIn([], u.id)))).toEqual({ done: [], skipped: [] });
    expect(await logged.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [], by: u.id }))).toEqual({ done: [], skipped: [], uploadIds: [] });
    expect(queries.filter(q => !TXN_CONTROL.test(q.trim()))).toEqual([]);
  });

  it("lock order: the first SQL of move / restore / permanent delete is a FOR UPDATE in ascending id (spaces empty)", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [a, b] = await Promise.all([seedNote(db, { ownerId: u.id }), seedNote(db, { ownerId: u.id })]);
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const firstOf = async (run: (tx: Tx) => Promise<unknown>) => {
      queries.length = 0;
      await logged.transaction(run);
      return queries.filter(q => !TXN_CONTROL.test(q.trim()))[0] ?? "";
    };
    const firsts = {
      trash: await firstOf(tx => trashNotesInTx(tx, { ids: desc(a.id, b.id), by: u.id })),
      restore: await firstOf(tx => restoreNotesInTx(tx, restoreIn(desc(a.id, b.id), u.id))),
      purge: await firstOf(async tx => {
        await trashNotesInTx(tx, { ids: [a.id, b.id], by: u.id });
        queries.length = 0;
        return purgeTrashedNotesInTx(tx, { ids: desc(a.id, b.id), by: u.id });
      }),
    };
    for (const [name, first] of Object.entries(firsts)) {
      expect(first, name).toMatch(/from "notes"/);
      expect(first, name).toContain(`order by "notes"."id"`);
      expect(first, name).toContain("for update");
    }
    expect(await exists(db, a.id)).toBe(false);
  });
});

describe("#181 restoreNotesInTx", () => {
  it("restore happy path: both columns cleared to NULL, shares and public fields as they were; the bystander's trashed note stays in trash, live notes untouched", async () => {
    const { db, pool } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedNote(db, { ownerId: u.id }, { publicToken: "r".repeat(43), publicSlug: "alias-r1" });
    await seedShare(db, n.id, v.id, "viewer");
    const trashedSibling = await seedNote(db, { ownerId: u.id });
    const trashedOther = await seedNote(db, { ownerId: v.id });
    const live = await seedNote(db, { ownerId: u.id });
    await markTrashed(pool, n.id, u.id, "1 hour");
    await markTrashed(pool, trashedSibling.id, u.id, "1 hour");
    await markTrashed(pool, trashedOther.id, v.id, "1 hour");
    const before = await noteState(pool, n.id);
    const sib = await trashCols(pool, trashedSibling.id);
    const oth = await trashCols(pool, trashedOther.id);

    expect(await db.transaction(tx => restoreNotesInTx(tx, restoreIn([n.id], u.id)))).toEqual({ done: [n.id], skipped: [] });
    expect(await trashCols(pool, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await noteState(pool, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: v.id, role: "viewer" }]);
    expect(await trashCols(pool, trashedSibling.id)).toEqual(sib);
    expect(await trashCols(pool, trashedOther.id)).toEqual(oth);
    expect(await trashCols(pool, live.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("classification: live note not_in_trash, missing not_found, deleteOnly/editOnly/shared editor not_found, editDelete done; done and skipped both keep input order", async () => {
    const { db, pool } = await freshDb();
    const s = await sixRoleScene(db);
    const [t1, t2, live] = [await seedNote(db, { groupId: s.groupId }), await seedNote(db, { groupId: s.groupId }), await seedNote(db, { groupId: s.groupId })];
    await markTrashed(pool, t1.id, s.admin.id);
    await markTrashed(pool, t2.id, s.admin.id);
    const missing = randomUUID();
    const [bigSkip, smallSkip] = desc(live.id, missing);
    const [bigDone, smallDone] = desc(t1.id, t2.id);

    const out = await db.transaction(tx => restoreNotesInTx(tx, restoreIn([bigSkip!, bigDone!, smallSkip!, smallDone!], s.editDelete.id)));
    const reasonOf = (id: string) => (id === live.id ? "not_in_trash" : "not_found");
    expect(out).toEqual({
      done: [bigDone, smallDone],
      skipped: [{ id: bigSkip, reason: reasonOf(bigSkip!) }, { id: smallSkip, reason: reasonOf(smallSkip!) }],
    });

    const t3 = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool, t3.id, s.admin.id);
    for (const [name, by] of [["deleteOnly", s.deleteOnly.id], ["editOnly", s.editOnly.id], ["outsider", s.outsider.id]] as const) {
      expect(await db.transaction(tx => restoreNotesInTx(tx, restoreIn([t3.id], by))), name).toEqual({ done: [], skipped: [{ id: t3.id, reason: "not_found" }] });
    }
    const owner = await seedUser(db);
    const p = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, p.id, s.editDelete.id, "editor");
    await markTrashed(pool, p.id, owner.id);
    expect(await db.transaction(tx => restoreNotesInTx(tx, restoreIn([p.id], s.editDelete.id)))).toEqual({ done: [], skipped: [{ id: p.id, reason: "not_found" }] });
    expect((await trashCols(pool, t3.id))?.deleted_at).not.toBeNull();
    expect((await trashCols(pool, p.id))?.deleted_at).not.toBeNull();
  });
});

describe("#181 purgeTrashedNotesInTx", () => {
  it("permanent delete: the trashed note and its uploads rows disappear, uploadIds returned; a live note is not_in_trash and its row and child tables stay", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const trashed = await seedNote(db, { ownerId: u.id });
    const live = await seedNote(db, { ownerId: u.id });
    const upT = await seedUploadRow(db, trashed.id, u.id);
    const upL = await seedUploadRow(db, live.id, u.id);
    await db.insert(noteStates).values({ noteId: live.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    await markTrashed(pool, trashed.id, u.id);

    const out = await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [trashed.id, live.id], by: u.id }));
    expect(out).toEqual({ done: [trashed.id], skipped: [{ id: live.id, reason: "not_in_trash" }], uploadIds: [upT] });
    expect(await exists(db, trashed.id)).toBe(false);
    expect(await uploadIdsOf(db, trashed.id)).toEqual([]);
    expect(await exists(db, live.id)).toBe(true);
    expect(await uploadIdsOf(db, live.id)).toEqual([upL]);
    expect(await db.select({ id: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, live.id))).toHaveLength(1);
  });

  it("no trash right (deleteOnly) -> not_found, row stays", async () => {
    const { db, pool } = await freshDb();
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool, gn.id, s.deleteOnly.id);
    expect(await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [gn.id], by: s.deleteOnly.id })))
      .toEqual({ done: [], skipped: [{ id: gn.id, reason: "not_found" }], uploadIds: [] });
    expect(await exists(db, gn.id)).toBe(true);
  });
});

describe("#181 purgeExpiredBatchInTx", () => {
  it("cleanup batch: takes only those older than the retention period, ordered by deleted_at ascending; limit 1 returns only the oldest; returns the deleted uploadIds", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [over, under, old, live] = [
      await seedNote(db, { ownerId: u.id }), await seedNote(db, { ownerId: u.id }),
      await seedNote(db, { ownerId: u.id }), await seedNote(db, { ownerId: u.id }),
    ];
    await markTrashed(pool, over.id, u.id, "7 days 1 minute");
    await markTrashed(pool, under.id, u.id, "6 days 23 hours 59 minutes");
    await markTrashed(pool, old.id, u.id, "30 days");
    const upOld = await seedUploadRow(db, old.id, u.id);

    expect(await rolledBack(db, tx => purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 100 })))
      .toEqual({ noteIds: [old.id, over.id], uploadIds: [upOld] });
    expect(await db.transaction(tx => purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 1 })))
      .toEqual({ noteIds: [old.id], uploadIds: [upOld] });
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [over.id, under.id, old.id, live.id])).then(r => r.map(x => x.id).sort()))
      .toEqual([over.id, under.id, live.id].sort());
  });

  it("strictly-less boundary: exactly 7 days is kept, 7 days + 1 second is deleted (now() is fixed within one transaction)", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const [x, y] = [await seedNote(db, { ownerId: u.id }), await seedNote(db, { ownerId: u.id })];
    const out = await db.transaction(async tx => {
      await tx.execute(sql`update notes set deleted_at = now() - interval '7 days' where id = ${x.id}`);
      await tx.execute(sql`update notes set deleted_at = now() - interval '7 days 1 second' where id = ${y.id}`);
      return purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 100 });
    });
    expect(out.noteIds).toEqual([y.id]);
    expect(await exists(db, x.id)).toBe(true);
  });

  it("SKIP LOCKED: due rows locked by another transaction are not waited for and an empty result returns; after the lock is released the next round deletes them", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await markTrashed(pool, n.id, u.id, "8 days");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from notes where id = $1 for update", [n.id]);
      const p = db.transaction(tx => purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 100 }));
      expect(await waitForBlockedOrSettled(pool, p)).toBe("settled");
      expect(await p).toEqual({ noteIds: [], uploadIds: [] });
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    expect(await db.transaction(tx => purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 100 }))).toEqual({ noteIds: [n.id], uploadIds: [] });
  });
});

describe("test hooks of the trash transactions", () => {
  it("each of the four calls its own point after the lock, ctx.noteId = the first note (spaces empty)", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [a, b, c] = [await seedNote(db, { ownerId: u.id }), await seedNote(db, { ownerId: u.id }), await seedNote(db, { ownerId: u.id })];
    const calls: Array<[GroupRacePoint, string | undefined]> = [];
    const hook = async (point: GroupRacePoint, ctx: { noteId?: string }) => { calls.push([point, ctx.noteId]); };
    await db.transaction(tx => trashNotesInTx(tx, { ids: [a.id, b.id], by: u.id }, hook));
    await db.transaction(tx => restoreNotesInTx(tx, restoreIn([b.id], u.id), hook));
    await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [a.id], by: u.id }, hook));
    await markTrashed(pool, c.id, u.id, "30 days");
    await db.transaction(tx => purgeExpiredBatchInTx(tx, { retentionDays: 7, limit: 100 }, hook));
    expect(calls).toEqual([
      ["note-trash-locked", a.id],
      ["note-restore-locked", b.id],
      ["note-purge-locked", a.id],
      ["trash-purge-locked", c.id],
    ]);
  });
});
