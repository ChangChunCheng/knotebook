/** Drives the delete-group transaction functions directly, without the route. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import * as Y from "yjs";
import { validateSlug } from "@knotebook/shared";
import { groupMembers, groupRoles, groups, noteAiEdits, noteLinks, noteRedirects, noteStates, notes, uploads } from "../src/db/schema.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { deleteGroupWithNotesInTx, transferGroupInTx } from "../src/groups/tx/delete-group.js";
import { TxAbort } from "../src/http/tx-abort.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import type { Db } from "../src/db/index.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { buildTestApp } from "./helpers.js";
import { noteState, seedGroup, seedNote, seedRedirect, seedRole, seedUser, setMemberRole } from "./group-helpers.js";
import { seedUpload } from "./copy-helpers.js";

const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort();

async function groupRows(db: Db, groupId: string): Promise<{ groups: number; roles: number; members: number }> {
  const [g, r, m] = await Promise.all([
    db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)),
    db.select({ id: groupRoles.id }).from(groupRoles).where(eq(groupRoles.groupId, groupId)),
    db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId)),
  ]);
  return { groups: g.length, roles: r.length, members: m.length };
}

async function redirectsOf(db: Db): Promise<Array<{ oldPath: string; noteId: string }>> {
  const rows = await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects);
  return rows.sort((a, b) => (a.oldPath < b.oldPath ? -1 : a.oldPath > b.oldPath ? 1 : 0));
}

describe("#175 transferGroupInTx", () => {
  it("transfer: each note becomes a personal note of transferTo (slug kept or -N, slug_is_custom unchanged, prev_slug/public_token/public_slug cleared, legacy_slug and updated_at unchanged); exactly one /g/<lowercase g>/<old slug> redirect per note; group, roles and members removed; AI records, links, uploads and note_states follow the UUID; returns noteIds and memberIds", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const legacy = `legacy-${randomUUID().slice(0, 12)}`;
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "plan", slugIsCustom: true, prevSlug: "old", publicToken: "t".repeat(43), legacySlug: legacy });
    const n2 = await seedNote(db, { groupId: g.id }, { slug: "x" });
    const n3 = await seedNote(db, { groupId: g.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "x" });
    await seedNote(db, { ownerId: b.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y-2" });
    await db.insert(noteAiEdits).values({ noteId: n1.id, userId: a.id, op: "append" });
    await db.insert(noteLinks).values({ sourceNoteId: n1.id, targetNoteId: n2.id });
    const [up] = await db.insert(uploads).values({ noteId: n1.id, uploaderId: a.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });
    await db.insert(noteStates).values({ noteId: n1.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    const before = await Promise.all([n1, n2, n3].map(n => noteState(pool, n.id)));

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(await noteState(pool, n1.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "plan", prev_slug: null, slug_is_custom: true, public_token: null, public_slug: null,
      updated_at: before[0]!.updated_at,
    });
    expect(await noteState(pool, n2.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "x-2", prev_slug: null, slug_is_custom: false, public_token: null, public_slug: null,
      updated_at: before[1]!.updated_at,
    });
    expect(await noteState(pool, n3.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "y-3", prev_slug: null, slug_is_custom: false, public_token: null, public_slug: null,
      updated_at: before[2]!.updated_at,
    });
    const { rows: legacyRows } = await pool.query("select legacy_slug from notes where id = $1", [n1.id]);
    expect(legacyRows).toEqual([{ legacy_slug: legacy }]);
    // Only the current slug gets a redirect, not prev_slug ('old').
    expect(await redirectsOf(db)).toEqual([
      { oldPath: `/g/${g.id.toLowerCase()}/plan`, noteId: n1.id },
      { oldPath: `/g/${g.id.toLowerCase()}/x`, noteId: n2.id },
      { oldPath: `/g/${g.id.toLowerCase()}/y`, noteId: n3.id },
    ]);
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n1.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(and(eq(noteLinks.sourceNoteId, n1.id), eq(noteLinks.targetNoteId, n2.id)))).toHaveLength(1);
    expect(await db.select({ noteId: uploads.noteId }).from(uploads).where(eq(uploads.id, up!.id))).toEqual([{ noteId: n1.id }]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, n1.id))).toHaveLength(1);
    expect(sorted(out.noteIds)).toEqual(sorted([n1.id, n2.id, n3.id]));
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, b.id, c.id]));
  });

  it("collision chain is processed by created_at, id: the earlier a-2 keeps its slug, the later a becomes a-3", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    await seedNote(db, { ownerId: b.id }, { slug: "a" });
    // Physical insert order Q->P equals slug order (a < a-2) but is opposite to creation order (P is earlier); processing by slug or insert order would give Q=a-2, P=a-2-2.
    // The ids are also opposite to creation order (q < p), so processing by id (the lock order) would be wrong too.
    const q = await seedNote(db, { groupId: g.id }, { id: "00000000-0000-4000-8000-000000000001", slug: "a" });
    const p = await seedNote(db, { groupId: g.id }, { id: "ffffffff-0000-4000-8000-000000000001", slug: "a-2" });
    await pool.query("update notes set created_at = now() - interval '1 hour' where id = $1", [p.id]);
    await pool.query("update notes set created_at = now() where id = $1", [q.id]);

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect((await noteState(pool, p.id)).slug).toBe("a-2");
    expect((await noteState(pool, q.id)).slug).toBe("a-3");
    expect(await redirectsOf(db)).toEqual([
      { oldPath: `/g/${g.id}/a`, noteId: q.id },
      { oldPath: `/g/${g.id}/a-2`, noteId: p.id },
    ]);
    expect(out.noteIds).toEqual([p.id, q.id]);
  });

  it("created_at differing by 1 microsecond (same millisecond) is still processed by created_at: the earlier a-2 keeps its slug, the later a becomes a-3", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    await seedNote(db, { ownerId: b.id }, { slug: "a" });
    // Same reversed ids as the previous test (q < p): millisecond or second precision would tie the two and fall back to id, so q would be processed first, which is wrong.
    const q = await seedNote(db, { groupId: g.id }, { id: "00000000-0000-4000-8000-000000000001", slug: "a" });
    const p = await seedNote(db, { groupId: g.id }, { id: "ffffffff-0000-4000-8000-000000000001", slug: "a-2" });
    await pool.query("update notes set created_at = '2026-01-01 00:00:00.000100+00' where id = $1", [p.id]);
    await pool.query("update notes set created_at = '2026-01-01 00:00:00.000101+00' where id = $1", [q.id]);

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect((await noteState(pool, p.id)).slug).toBe("a-2");
    expect((await noteState(pool, q.id)).slug).toBe("a-3");
    expect(await redirectsOf(db)).toEqual([
      { oldPath: `/g/${g.id}/a`, noteId: q.id },
      { oldPath: `/g/${g.id}/a-2`, noteId: p.id },
    ]);
    expect(out.noteIds).toEqual([p.id, q.id]);
  });

  it("100-char custom slug colliding within the transferTo scope -> at most 60 chars, ends in -2, passes validateSlug, slug_is_custom stays true; the redirect key is the 100-char old slug", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const base = "b".repeat(100);
    const n = await seedNote(db, { groupId: g.id }, { slug: base, slugIsCustom: true });
    await seedNote(db, { ownerId: b.id }, { slug: base });

    await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    const expected = nextSlugCandidate(base, 2);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
    expect(expected.endsWith("-2")).toBe(true);
    expect(validateSlug(expected)).toBeNull();
    expect(await noteState(pool, n.id)).toMatchObject({ slug: expected, slug_is_custom: true, owner_id: b.id, group_id: null });
    expect(await redirectsOf(db)).toEqual([{ oldPath: `/g/${g.id}/${base}`, noteId: n.id }]);
  });

  it("transferTo that is not a built-in admin -> TxAbort 409 not_admin for a non-member, a plain member and a custom-role member with all seven flags; transaction rolls back and group, notes, members are untouched", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, c, d, outsider] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }, { userId: d.id, role: "member" }]);
    const boss = await seedRole(db, g.id, "Boss", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await setMemberRole(db, g.id, d.id, boss);
    const n = await seedNote(db, { groupId: g.id }, { slug: "keep", publicToken: "k".repeat(43) });
    const noteBefore = await noteState(pool, n.id);
    const rowsBefore = await groupRows(db, g.id);

    const errs: unknown[] = [];
    for (const who of [outsider, c, d]) {
      const err = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: who.id, by: who.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS })).then(
        () => null,
        (e: unknown) => e,
      );
      errs.push(err);
    }

    for (const err of errs) {
      expect(err).toBeInstanceOf(TxAbort);
      expect(err).toMatchObject({ status: 409, errCode: "not_admin", message: NOT_ADMIN_MESSAGE });
    }
    expect(new Set(errs.map(e => (e as TxAbort).message)).size).toBe(1);
    expect(await noteState(pool, n.id)).toEqual(noteBefore);
    expect(await groupRows(db, g.id)).toEqual(rowsBefore);
    expect(rowsBefore).toEqual({ groups: 1, roles: 3, members: 3 });
    expect(await redirectsOf(db)).toEqual([]);
  });

  it("missing group -> TxAbort 404 not_found (GROUP_NOT_FOUND_MESSAGE)", async () => {
    const { db } = await buildTestApp();
    const b = await seedUser(db);
    const err = await db.transaction(tx => transferGroupInTx(tx, { groupId: randomUUID(), transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxAbort);
    expect(err).toMatchObject({ status: 404, errCode: "not_found", message: GROUP_NOT_FOUND_MESSAGE });
  });

  it("empty group: returns noteIds [], group removed, 0 redirects", async () => {
    const { db } = await buildTestApp();
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: a.id, by: a.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(out.noteIds).toEqual([]);
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, c.id]));
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await redirectsOf(db)).toEqual([]);
  });
});

describe("#175 deleteGroupWithNotesInTx", () => {
  it("delete all: every note in L is removed with its uploads rows, states, redirects, AI records and links in both directions; notes outside the group (including the other end of a link) survive; returns uploadIds of the deleted uploads, noteIds = L, memberIds = all members; group, roles and members removed", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const g1 = await seedNote(db, { groupId: g.id }, { slug: "g1" });
    const g2 = await seedNote(db, { groupId: g.id }, { slug: "g2" });
    const p = await seedNote(db, { ownerId: c.id }, { slug: "p" });
    const elsewhere = await seedNote(db, { groupId: other.id }, { slug: "g1" });
    await db.insert(noteLinks).values([{ sourceNoteId: p.id, targetNoteId: g1.id }, { sourceNoteId: g1.id, targetNoteId: p.id }]);
    const up = await seedUpload(db, uploadsDir, g1.id, a.id);
    const keptUp = await seedUpload(db, uploadsDir, p.id, c.id);
    await db.insert(noteStates).values({ noteId: g1.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    await db.insert(noteAiEdits).values({ noteId: g2.id, userId: a.id, op: "append" });
    await seedRedirect(db, `/g/${g.id}/old-g1`, g1.id);
    const linkWhere = or(inArray(noteLinks.sourceNoteId, [g1.id, g2.id]), inArray(noteLinks.targetNoteId, [g1.id, g2.id]));
    expect(await db.select().from(noteLinks).where(linkWhere)).toHaveLength(2);

    const out = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: g.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [g1.id, g2.id]))).toEqual([]);
    expect(await db.select().from(noteLinks).where(linkWhere)).toEqual([]);
    expect(await db.select().from(uploads).where(eq(uploads.id, up))).toEqual([]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, g1.id))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, g2.id))).toEqual([]);
    expect(await redirectsOf(db)).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [p.id, elsewhere.id]))).toHaveLength(2);
    expect(await db.select().from(uploads).where(eq(uploads.id, keptUp))).toHaveLength(1);
    expect(out.uploadIds).toEqual([up]);
    expect(sorted(out.noteIds)).toEqual(sorted([g1.id, g2.id]));
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, c.id]));
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await groupRows(db, other.id)).toEqual({ groups: 1, roles: 2, members: 1 });
  });

  it("delete all: missing group -> TxAbort 404 not_found", async () => {
    const { db } = await buildTestApp();
    const err = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: randomUUID(), lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxAbort);
    expect(err).toMatchObject({ status: 404, errCode: "not_found", message: GROUP_NOT_FOUND_MESSAGE });
  });

  it("delete all: empty group -> returns three empty arrays, group removed", async () => {
    const { db } = await buildTestApp();
    const g = await seedGroup(db, "G", []);

    const out = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: g.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(out).toEqual({ noteIds: [], memberIds: [], uploadIds: [] });
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
  });
});

describe("#175 delete-group test hooks", () => {
  /**
   * "After the group lock, before fetching notes" is probed from another connection with `FOR UPDATE NOWAIT`:
   * groups row already locked by `lockGroup` -> 55P03; group notes not yet locked FOR UPDATE -> succeeds (autocommit, releases at once).
   */
  const probeLocks = async (pool: Db["$client"], groupId: string) => {
    const tryLock = (q: string) => pool.query(q, [groupId]).then(() => "free", (e: { code?: string }) => (e.code === "55P03" ? "locked" : `error:${e.code}`));
    return {
      group: await tryLock("select id from groups where id = $1 for update nowait"),
      notes: await tryLock("select id from notes where group_id = $1 for update nowait"),
    };
  };

  it("group-transfer-slug-candidate fires once per round with noteId and the round's candidate; group-delete-locked fires once after the transferTo check (transfer) / before fetching L (delete all); folder-structure-locked follows it, before the notes are locked", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n3 = await seedNote(db, { groupId: g.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y-2" });

    // transferTo is a plain member (not_admin): the check runs before the seam, so no hook fires.
    const rejected: GroupRacePoint[] = [];
    await expect(
      db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: c.id, by: c.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, async point => { rejected.push(point); })),
    ).rejects.toBeInstanceOf(TxAbort);
    expect(rejected).toEqual([]);

    const calls: Array<{ point: GroupRacePoint; ctx: unknown; locks?: unknown }> = [];
    await db.transaction(tx =>
      transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, by: b.id, fallbackFolderName: "Group", lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, async (point, ctx) => {
        calls.push({ point, ctx, ...(point === "group-delete-locked" || point === "folder-structure-locked" ? { locks: await probeLocks(pool, g.id) } : {}) });
      }),
    );
    expect(calls).toEqual([
      { point: "group-delete-locked", ctx: { groupId: g.id }, locks: { group: "locked", notes: "free" } },
      { point: "folder-structure-locked", ctx: { groupId: g.id }, locks: { group: "locked", notes: "free" } },
      { point: "group-transfer-slug-candidate", ctx: { noteId: n3.id, groupId: g.id, slug: "y-3" } },
    ]);

    const g2 = await seedGroup(db, "G2", [{ userId: a.id, role: "admin" }]);
    await seedNote(db, { groupId: g2.id }, { slug: "z" });
    const calls2: Array<{ point: GroupRacePoint; ctx: unknown; locks: unknown }> = [];
    await db.transaction(tx =>
      deleteGroupWithNotesInTx(tx, { groupId: g2.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, async (point, ctx) => {
        calls2.push({ point, ctx, locks: await probeLocks(pool, g2.id) });
      }),
    );
    expect(calls2).toEqual([
      { point: "group-delete-locked", ctx: { groupId: g2.id }, locks: { group: "locked", notes: "free" } },
      { point: "folder-structure-locked", ctx: { groupId: g2.id }, locks: { group: "locked", notes: "free" } },
    ]);
  });
});
