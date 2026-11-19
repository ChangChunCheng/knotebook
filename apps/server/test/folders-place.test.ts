import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NoteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { placeNoteInTx, type PlaceNoteInput } from "../src/folders/tx/place-note.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { noteFolderCols, placementOf, seedFolder, seedPlacement, setNoteFolder, xminOf } from "./folder-helpers.js";
import { noteState, seedGroup, seedNote, seedRedirect, seedShare, seedUser } from "./group-helpers.js";
import { buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { inject, markTrashed, sixRoleScene } from "./trash-helpers.js";

const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const CROSS_SPACE = "A note can't go into a folder in another space.";
const NO_ORGANIZE = "You don't have permission to organize this note.";
const NOTE_NOT_FOUND = "No note with that id.";

const put = (app: FastifyInstance, userId: string | null, noteId: string, body: unknown) =>
  inject(app, "PUT", `/api/notes/${noteId}/folder`, userId, body);

function ok(res: LightMyRequestResponse): NoteDto {
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteDto;
}
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

/** Test hook: after `arm(point, fn)`, the first time point is passed fn runs (once only). */
function armedHook() {
  let armed: { point: GroupRacePoint; fn: () => Promise<void> } | null = null;
  return {
    hook: async (point: GroupRacePoint) => {
      if (armed && armed.point === point) {
        const { fn } = armed;
        armed = null;
        await fn();
      }
    },
    arm(point: GroupRacePoint, fn: () => Promise<void>) {
      armed = { point, fn };
    },
    get pending() {
      return armed !== null;
    },
  };
}

async function noteIn(db: Db, pool: Pool, owner: { ownerId: string } | { groupId: string }, folderId: string | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(pool, n.id, folderId);
  return n.id;
}

async function listOf(app: FastifyInstance, userId: string): Promise<NoteDto[]> {
  const res = await inject(app, "GET", "/api/notes", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteDto[];
}

/** The surfaces a placement must not touch (url, public columns, updated_at, versions, Y.Doc state, redirects). */
async function untouchable(pool: Pool, noteId: string) {
  const versions = await pool.query<{ n: number }>("select count(*)::int as n from note_versions where note_id = $1", [noteId]);
  const state = await pool.query("select version, updated_at::text as updated_at from note_states where note_id = $1", [noteId]);
  const redirects = await pool.query<{ old_path: string }>("select old_path from note_redirects where note_id = $1 order by old_path", [noteId]);
  return {
    note: await noteState(pool, noteId),
    versions: versions.rows[0]!.n,
    state: state.rows[0] ?? null,
    redirects: redirects.rows.map(r => r.old_path),
  };
}

/** xmin of the placement row (to tell "nothing was written"). */
async function placementXmin(pool: Pool, userId: string, noteId: string): Promise<string> {
  const { rows } = await pool.query<{ x: string }>("select xmin::text as x from note_placements where user_id = $1 and note_id = $2", [userId, noteId]);
  return rows[0]!.x;
}

async function roleIdOf(pool: Pool, groupId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [groupId, userId]);
  return rows[0]!.role_id;
}

describe("PUT /api/notes/:id/folder", () => {
  it("personal note: put into own folder, move back to root, same value is idempotent and writes nothing; invisible folders in three forms byte-for-byte identical; cross-space 400; bystanders in the same folder untouched", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const other = await seedUser(db);
    const F0 = (await seedFolder(db, { personal: u.id })).id;
    const F = (await seedFolder(db, { personal: u.id })).id;
    const n = await noteIn(db, pool, { ownerId: u.id }, F0);
    const sib = await noteIn(db, pool, { ownerId: u.id }, F0);
    const rootNote = await noteIn(db, pool, { ownerId: u.id }, null);
    const othersNote = await noteIn(db, pool, { ownerId: other.id }, null);

    expect(ok(await put(app, u.id, n, { folderId: F })).folderId).toBe(F);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(F);
    // Bystanders: another note in the same old folder, one at the root, one belonging to someone else
    expect((await noteFolderCols(pool, sib))?.folder_id).toBe(F0);
    expect((await noteFolderCols(pool, rootNote))?.folder_id).toBeNull();
    expect((await noteFolderCols(pool, othersNote))?.folder_id).toBeNull();

    const x0 = await xminOf(pool, "notes", n);
    expect(ok(await put(app, u.id, n, { folderId: F })).folderId).toBe(F);
    expect(await xminOf(pool, "notes", n)).toBe(x0);

    expect(ok(await put(app, u.id, n, { folderId: null })).folderId).toBeNull();
    expect((await noteFolderCols(pool, n))?.folder_id).toBeNull();
    const x1 = await xminOf(pool, "notes", n);
    expect(ok(await put(app, u.id, n, { folderId: null })).folderId).toBeNull();
    expect(await xminOf(pool, "notes", n)).toBe(x1);

    const othersFolder = (await seedFolder(db, { personal: other.id })).id;
    const hidden = failed(await put(app, u.id, n, { folderId: othersFolder }), 404, "folder_not_found");
    expect(failed(await put(app, u.id, n, { folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(hidden);
    expect(failed(await put(app, u.id, n, { folderId: "x" }), 404, "folder_not_found")).toBe(hidden);

    const mineShared = (await seedFolder(db, { shared: u.id })).id;
    const g = await seedGroup(db, "FP1", [{ userId: u.id, role: "admin" }]);
    const gf = (await seedFolder(db, { group: g.id })).id;
    for (const target of [mineShared, gf]) {
      const res = await put(app, u.id, n, { folderId: target });
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res)).toBe(CROSS_SPACE);
    }
    expect((await noteFolderCols(pool, n))?.folder_id).toBeNull();
    expect(await xminOf(pool, "notes", n)).toBe(x1);
  });

  it("group note: admin/member/editDelete/editOnly 200; deleteOnly/readOnly 403; outsider 404 not_found; another group I'm in 400; a group I'm not in 404 folder_not_found", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null);

    for (const actor of [s.admin, s.member, s.editDelete, s.editOnly]) {
      expect(ok(await put(app, actor.id, gn, { folderId: GF })).folderId, actor.id).toBe(GF);
      expect((await noteFolderCols(pool, gn))?.folder_id).toBe(GF);
      expect(ok(await put(app, actor.id, gn, { folderId: null })).folderId, actor.id).toBeNull();
      expect((await noteFolderCols(pool, gn))?.folder_id).toBeNull();
    }
    for (const actor of [s.deleteOnly, s.readOnly]) {
      const res = await put(app, actor.id, gn, { folderId: GF });
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(NO_ORGANIZE);
    }
    const outsider = await put(app, s.outsider.id, gn, { folderId: GF });
    failed(outsider, 404, "not_found");
    expect(messageOf(outsider)).toBe(NOTE_NOT_FOUND);
    expect((await noteFolderCols(pool, gn))?.folder_id).toBeNull();

    const both = await seedGroup(db, "FP2-both", [{ userId: s.admin.id, role: "member" }]);
    const bothFolder = (await seedFolder(db, { group: both.id })).id;
    const cross = await put(app, s.admin.id, gn, { folderId: bothFolder });
    failed(cross, 400, "folder_cross_space");
    expect(messageOf(cross)).toBe(CROSS_SPACE);

    const stranger = await seedUser(db);
    const notMine = await seedGroup(db, "FP2-not-mine", [{ userId: stranger.id, role: "admin" }]);
    const notMineFolder = (await seedFolder(db, { group: notMine.id })).id;
    const hidden = failed(await put(app, s.admin.id, gn, { folderId: notMineFolder }), 404, "folder_not_found");
    expect(failed(await put(app, s.admin.id, gn, { folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(hidden);
    expect((await noteFolderCols(pool, gn))?.folder_id).toBeNull();
  });

  it("shared note: editor and viewer can both place it in their own shared folder (writes a placement row); the owner's folder_id, xmin and list are unchanged; the same value writes nothing, can move between two shared folders; null deletes the placement; own personal folder 400, someone else's shared folder 404", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const owner = await seedUser(db);
    const ed = await seedUser(db);
    const vw = await seedUser(db);
    const FO = (await seedFolder(db, { personal: owner.id })).id;
    const n = await noteIn(db, pool, { ownerId: owner.id }, FO);
    await seedShare(db, n, ed.id, "editor");
    await seedShare(db, n, vw.id, "viewer");
    const SE = (await seedFolder(db, { shared: ed.id })).id;
    const SV = (await seedFolder(db, { shared: vw.id })).id;
    // Bystander: ed's placement on another note
    const n2 = await noteIn(db, pool, { ownerId: owner.id }, null);
    await seedShare(db, n2, ed.id, "viewer");
    await seedPlacement(pool, ed.id, n2, SE);
    const x0 = await xminOf(pool, "notes", n);
    const before = await untouchable(pool, n);

    expect(ok(await put(app, ed.id, n, { folderId: SE })).folderId).toBe(SE);
    expect(ok(await put(app, vw.id, n, { folderId: SV })).folderId).toBe(SV);
    expect(await placementOf(pool, ed.id, n)).toBe(SE);
    expect(await placementOf(pool, vw.id, n)).toBe(SV);
    expect((await listOf(app, ed.id)).find(x => x.id === n)?.folderId).toBe(SE);
    expect((await listOf(app, vw.id)).find(x => x.id === n)?.folderId).toBe(SV);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(FO);
    expect(await xminOf(pool, "notes", n)).toBe(x0);
    expect((await listOf(app, owner.id)).find(x => x.id === n)?.folderId).toBe(FO);
    expect(await untouchable(pool, n)).toEqual(before);

    const px0 = await placementXmin(pool, ed.id, n);
    expect(ok(await put(app, ed.id, n, { folderId: SE })).folderId).toBe(SE);
    expect(await placementOf(pool, ed.id, n)).toBe(SE);
    expect(await placementXmin(pool, ed.id, n)).toBe(px0);

    // Moving between her own two shared folders (the update branch of the upsert)
    const SE2 = (await seedFolder(db, { shared: ed.id })).id;
    expect(ok(await put(app, ed.id, n, { folderId: SE2 })).folderId).toBe(SE2);
    expect(await placementOf(pool, ed.id, n)).toBe(SE2);
    expect(await placementOf(pool, vw.id, n)).toBe(SV);
    expect(await placementOf(pool, ed.id, n2)).toBe(SE);
    expect(await xminOf(pool, "notes", n)).toBe(x0);

    expect(ok(await put(app, ed.id, n, { folderId: null })).folderId).toBeNull();
    expect(await placementOf(pool, ed.id, n)).toBeNull();
    expect(await placementOf(pool, vw.id, n)).toBe(SV);
    expect(await placementOf(pool, ed.id, n2)).toBe(SE);

    const edPersonal = (await seedFolder(db, { personal: ed.id })).id;
    const cross = await put(app, ed.id, n, { folderId: edPersonal });
    failed(cross, 400, "folder_cross_space");
    expect(messageOf(cross)).toBe(CROSS_SPACE);
    failed(await put(app, ed.id, n, { folderId: SV }), 404, "folder_not_found");
    expect(await placementOf(pool, ed.id, n)).toBeNull();
    expect(await xminOf(pool, "notes", n)).toBe(x0);
  });

  it("share revoked: the placement row disappears with it, the shared user's list no longer shows the note", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const owner = await seedUser(db);
    const ed = await seedUser(db);
    const n = await noteIn(db, pool, { ownerId: owner.id }, null);
    await seedShare(db, n, ed.id, "editor");
    const SE = (await seedFolder(db, { shared: ed.id })).id;
    ok(await put(app, ed.id, n, { folderId: SE }));
    expect(await placementOf(pool, ed.id, n)).toBe(SE);

    const res = await inject(app, "DELETE", `/api/notes/${n}/shares/${ed.id}`, owner.id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await placementOf(pool, ed.id, n)).toBeNull();
    expect((await listOf(app, ed.id)).map(x => x.id)).not.toContain(n);
    failed(await put(app, ed.id, n, { folderId: SE }), 404, "not_found");
  });

  it("a shared placement revoked after the in-transaction re-judgement but before the write -> 404 not_found (not 500), no placement row; revoked after authorization but before the transaction is also 404", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const owner = await seedUser(db);
    const ed = await seedUser(db);
    const n = await noteIn(db, pool, { ownerId: owner.id }, null);
    await seedShare(db, n, ed.id, "editor");
    const SE = (await seedFolder(db, { shared: ed.id })).id;
    seam.arm("note-folder-locked", async () => {
      await pool.query("delete from note_shares where note_id = $1 and user_id = $2", [n, ed.id]);
    });

    const res = await put(app, ed.id, n, { folderId: SE });
    failed(res, 404, "not_found");
    expect(messageOf(res)).toBe(NOTE_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await placementOf(pool, ed.id, n)).toBeNull();

    // Revoked after authorization, before the transaction: the in-transaction re-judgement -> none -> 404 (not 403).
    await seedShare(db, n, ed.id, "editor");
    seam.arm("note-folder-authorized", async () => {
      await pool.query("delete from note_shares where note_id = $1 and user_id = $2", [n, ed.id]);
    });
    const early = await put(app, ed.id, n, { folderId: SE });
    failed(early, 404, "not_found");
    expect(messageOf(early)).toBe(NOTE_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await placementOf(pool, ed.id, n)).toBeNull();
  });

  it("in-transaction re-judgement: after authorization the group role loses can_edit -> 403, removed from the group -> 404 not_found, nothing written; a personal note's share is swapped to another person in the test hook, the owner unaffected", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null);
    const roleId = await roleIdOf(pool, s.groupId, s.editOnly.id);
    seam.arm("note-folder-authorized", async () => {
      await pool.query("update group_roles set can_edit = false where id = $1", [roleId]);
    });
    const res = await put(app, s.editOnly.id, gn, { folderId: GF });
    failed(res, 403, "forbidden");
    expect(messageOf(res)).toBe(NO_ORGANIZE);
    expect((await noteFolderCols(pool, gn))?.folder_id).toBeNull();

    // Removed from the group after authorization: inside the transaction the note is judged first -> not_found, not folder_not_found.
    seam.arm("note-folder-authorized", async () => {
      await pool.query("delete from group_members where group_id = $1 and user_id = $2", [s.groupId, s.member.id]);
    });
    const removed = await put(app, s.member.id, gn, { folderId: GF });
    failed(removed, 404, "not_found");
    expect(messageOf(removed)).toBe(NOTE_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect((await noteFolderCols(pool, gn))?.folder_id).toBeNull();

    const owner = await seedUser(db);
    const a = await seedUser(db);
    const b = await seedUser(db);
    const n = await noteIn(db, pool, { ownerId: owner.id }, null);
    await seedShare(db, n, a.id, "editor");
    const F = (await seedFolder(db, { personal: owner.id })).id;
    seam.arm("note-folder-authorized", async () => {
      await pool.query("delete from note_shares where note_id = $1", [n]);
      await pool.query("insert into note_shares (note_id, user_id, role) values ($1, $2, 'viewer')", [n, b.id]);
    });
    expect(ok(await put(app, owner.id, n, { folderId: F })).folderId).toBe(F);
    expect(seam.pending).toBe(false);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(F);
  });

  it("vanishing space and folder: group transferred after authorization -> 404 not_found; target folder deleted after authorization -> 404 folder_not_found (neither is a 500)", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null);
    seam.arm("note-folder-authorized", async () => {
      const del = await inject(app, "DELETE", `/api/groups/${s.groupId}`, s.admin.id, { mode: "transfer", transferTo: s.admin.id });
      expect(del.statusCode, del.body).toBe(204);
    });
    const res = await put(app, s.member.id, gn, { folderId: GF });
    failed(res, 404, "not_found");
    expect(messageOf(res)).toBe(NOTE_NOT_FOUND);
    expect(seam.pending).toBe(false);

    const u = await seedUser(db);
    const n = await noteIn(db, pool, { ownerId: u.id }, null);
    const doomed = (await seedFolder(db, { personal: u.id })).id;
    seam.arm("note-folder-authorized", async () => {
      await pool.query("delete from folders where id = $1", [doomed]);
    });
    const hiddenBody = failed(await put(app, u.id, n, { folderId: RANDOM_UUID }), 404, "folder_not_found");
    expect(failed(await put(app, u.id, n, { folderId: doomed }), 404, "folder_not_found")).toBe(hiddenBody);
    expect(seam.pending).toBe(false);
    expect((await noteFolderCols(pool, n))?.folder_id).toBeNull();
  });

  it("trash note 404 not_found; before and after a placement the url, public columns, updated_at, versions, note_states and redirects are all unchanged (personal and group)", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const F = (await seedFolder(db, { personal: u.id })).id;
    const t = await noteIn(db, pool, { ownerId: u.id }, null);
    await markTrashed(pool, t, u.id);
    const trashed = await put(app, u.id, t, { folderId: F });
    failed(trashed, 404, "not_found");
    expect(messageOf(trashed)).toBe(NOTE_NOT_FOUND);
    expect((await noteFolderCols(pool, t))?.folder_id).toBeNull();

    const n = (await seedNote(db, { ownerId: u.id }, { slugIsCustom: true, prevSlug: "old-n", publicToken: `tok-${u.id.slice(0, 8)}` })).id;
    await pool.query("insert into note_states (note_id, ydoc, version, updated_at) values ($1, '\\x00'::bytea, 7, now() - interval '1 hour')", [n]);
    await seedRedirect(db, `/n/${u.handle}/old-path-${n.slice(0, 8)}`, n);
    await pool.query("update notes set updated_at = now() - interval '2 hours' where id = $1", [n]);
    const before = await untouchable(pool, n);
    ok(await put(app, u.id, n, { folderId: F }));
    ok(await put(app, u.id, n, { folderId: null }));
    expect(await untouchable(pool, n)).toEqual(before);

    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null);
    await pool.query("update notes set updated_at = now() - interval '2 hours' where id = $1", [gn]);
    const gBefore = await untouchable(pool, gn);
    ok(await put(app, s.member.id, gn, { folderId: GF }));
    expect(await untouchable(pool, gn)).toEqual(gBefore);
  });

  it("lock order literally: group groups KS -> folder KS -> note FOR UPDATE; shared folder KS -> note KEY SHARE; personal move back to root takes no folder lock", async () => {
    const { db, pool } = await freshDb();
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const run = async (input: PlaceNoteInput) => {
      queries.length = 0;
      await logged.transaction(tx => placeNoteInTx(tx, input));
      return queries
        .filter(q => !TXN_CONTROL.test(q.trim()))
        .filter(q => /for (update|key share)$/.test(q.trim()));
    };

    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null);
    const gLocks = await run({ by: s.member.id, noteId: gn, folderId: GF, mode: { kind: "group", groupId: s.groupId } });
    expect(gLocks).toHaveLength(3);
    expect(gLocks[0]).toMatch(/ from "groups" .*for key share$/);
    expect(gLocks[1]).toMatch(/ from "folders" .*for key share$/);
    expect(gLocks[2]).toMatch(/ from "notes" .*for update$/);
    expect((await noteFolderCols(pool, gn))?.folder_id).toBe(GF);

    const owner = await seedUser(db);
    const ed = await seedUser(db);
    const n = await noteIn(db, pool, { ownerId: owner.id }, null);
    await seedShare(db, n, ed.id, "viewer");
    const SE = (await seedFolder(db, { shared: ed.id })).id;
    const sLocks = await run({ by: ed.id, noteId: n, folderId: SE, mode: { kind: "shared" } });
    expect(sLocks).toHaveLength(2);
    expect(sLocks[0]).toMatch(/ from "folders" .*for key share$/);
    expect(sLocks[1]).toMatch(/ from "notes" .*for key share$/);
    expect(await placementOf(pool, ed.id, n)).toBe(SE);

    const F = (await seedFolder(db, { personal: owner.id })).id;
    const pn = await noteIn(db, pool, { ownerId: owner.id }, F);
    const pLocks = await run({ by: owner.id, noteId: pn, folderId: null, mode: { kind: "owned" } });
    expect(pLocks).toHaveLength(1);
    expect(pLocks[0]).toMatch(/ from "notes" .*for update$/);
    expect(queries.some(q => q.includes('"folders"'))).toBe(false);
    expect((await noteFolderCols(pool, pn))?.folder_id).toBeNull();
  });

  it("misc: Bearer/not signed in 401; throttle 429; strict body (missing folderId, unknown key 400); uppercase :id and uppercase folderId 200", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ folder: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const pool = db.$client;
    const u = await seedUser(db);
    const F = (await seedFolder(db, { personal: u.id })).id;
    const n = await noteIn(db, pool, { ownerId: u.id }, null);

    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const viaBearer = await app.inject({ method: "PUT", url: `/api/notes/${n}/folder`, headers: bearer(rw.token), payload: { folderId: F } });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect((await put(app, null, n, { folderId: F })).statusCode).toBe(401);

    failed(await put(app, u.id, n, {}), 400, "invalid_body");
    failed(await put(app, u.id, n, { folderId: F, extra: 1 }), 400, "invalid_body");
    failed(await put(app, u.id, n, { folderId: 3 }), 400, "invalid_body");

    const upper = ok(await put(app, u.id, n.toUpperCase(), { folderId: F.toUpperCase() }));
    expect(upper.id).toBe(n);
    expect(upper.folderId).toBe(F);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(F);

    const limited = await put(app, u.id, n, { folderId: null });
    failed(limited, 429, "too_many_requests");
    expect(messageOf(limited)).toBe("Too many writes. Wait a moment and try again.");
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(F);
  });
});
