/**
 * Interleavings of the two group-delete modes: transfer x member changes, transfer's savepoint retry, delete-all x notes entering the group after the gate,
 * delete-all x transfer after the gate, copy/move/PATCH x group delete, token PUT x transfer, alias PUT x transfer + the recipient reopening the token (three-party shape),
 * and uploads while delete-all holds the group notes lock (the lock delete-all takes on the group notes is what blocks the upload).
 * Cases that must prove "an interleaving was tested" call `waitForBlockedOrSettled` inside the test hook and finally assert `"blocked"`; cases marked "sequential" `await` one complete request
 * inside the hook (the window is after authorization/the gate and before the transaction or UPDATE, so a sequence is enough).
 * No case writes the same old URL as a redirect twice: a transfer only writes the `/g/<deleted group>/<current slug>` key; a move and 0012 only write the `/n/` key; a group's current slugs are
 * unique within the group and the group no longer exists after the transfer - structurally they can't hit the same key.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { noteRedirects, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedUser, setMemberRole, sleep, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { PNG, imageDoc, seedDoc, seedUpload } from "./copy-helpers.js";

const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });
const deleteAll = async (app: FastifyInstance, groupId: string, userId: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });
const createInGroup = async (app: FastifyInstance, groupId: string, userId: string, title: string) =>
  app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(userId), payload: { groupId, title } });
const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });

const BOUNDARY = "kbDeleteRaceBoundary";
/** Multipart body with a single PNG file part (hand-built like `uploads.test.ts`). */
function pngMultipart(): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    PNG,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8"),
  ]);
}
const upload = async (app: FastifyInstance, noteId: string, userId: string) =>
  app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    cookies: await cookieOf(userId),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: pngMultipart(),
  });

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const groupRows = async (pool: Pool, groupId: string): Promise<number> =>
  (await pool.query<{ n: number }>("select count(*)::int as n from groups where id = $1", [groupId])).rows[0]!.n;
const notesOfGroup = async (pool: Pool, groupId: string): Promise<string[]> =>
  (await pool.query<{ id: string }>("select id from notes where group_id = $1 order by id", [groupId])).rows.map(r => r.id);
const noteCount = async (pool: Pool): Promise<number> => (await pool.query<{ n: number }>("select count(*)::int as n from notes")).rows[0]!.n;

const NOT_ADMIN_BODY = { error: { code: "not_admin", message: NOT_ADMIN_MESSAGE } };
const GROUP_NOT_FOUND_BODY = { error: { code: "not_found", message: "No group with that id." } };
const CREATE_GROUP_NOT_FOUND_BODY = { error: { code: "group_not_found", message: "No group with that id." } };
const CONFLICT_BODY = { error: { code: "conflict", message: "The note's owner or group changed. Reload and try again." } };
const ALIAS_REJECTED_BODY = {
  error: { code: "invalid_body", message: "Can't set a public URL: the note has no public link, is a group note, or changed owner after you sent this." },
};

type RaceState = { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string };

/** On the first occurrence of `point` sends a second request and waits until it is stuck on a lock (or finishes if not blocked). */
function raceHook(point: GroupRacePoint, state: RaceState, holder: { pool?: Pool }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.second) return;
    state.second = state.fire();
    state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
  };
}

/** On the first occurrence of `point` `await`s one complete request (sequential cases: the window is after the gate/authorization and before the transaction, no blocked needed). */
function serialHook(point: GroupRacePoint, state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.fired) return;
    state.fired = true;
    state.done = await state.fire();
  };
}

/** `spyCollabHooks` with `beforeNoteDeleted` replaced by a version with one `release` spy per gate. */
function gatedHooks() {
  const gates: Array<{ noteId: string; release: ReturnType<typeof vi.fn<() => void>> }> = [];
  const hooks = {
    ...spyCollabHooks(),
    beforeNoteDeleted: vi.fn(async (noteId: string) => {
      const release = vi.fn<() => void>();
      gates.push({ noteId, release });
      return { release };
    }),
  };
  return { hooks, gates };
}

describe("#175 transfer x member changes", () => {
  it("transferTo is demoted first and gets lockGroup (group-members-checked) -> the transfer's lockGroup waits -> demote 200, transfer 409 not_admin; group and notes untouched", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    const before = await noteState(db.$client, n.id);
    state.fire = () => transfer(app, g.id, a.id, b.id);

    const demoted = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(a.id), payload: { roleId: g.memberRoleId } });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toEqual(NOT_ADMIN_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("transfer holds the lock first (group-delete-locked) -> transferTo's leave lockGroup waits -> transfer 204, leave 404 not_found (the group is gone)", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    state.fire = async () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(b.id) });

    const moved = await transfer(app, g.id, a.id, b.id);
    const left = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(204);
    expect(left.statusCode).toBe(404);
    expect(left.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "plan" });
  });
});

describe("#175 transfer slug retry", () => {
  it("after the transfer probes candidate x (group-transfer-slug-candidate), transferTo's personal scope has x taken by another connection -> savepoint hits notes_owner_slug_idx and retries -> x-2; the outer transaction commits, redirect /g/<g>/x points to the transferred note", async () => {
    const holder: { db?: Parameters<typeof seedNote>[0]; ownerId?: string; seeded?: Promise<{ id: string; slug: string }>; interleave?: string } = {};
    const candidates: string[] = [];
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (p, ctx) => {
        if (p !== "group-transfer-slug-candidate") return;
        candidates.push(ctx.slug!);
        if (ctx.slug !== "x" || holder.seeded) return;
        // Another pool connection, autocommit: the insert touches no lock the transfer holds (the transfer hasn't written (B, x) yet) - sequential, so "settled" is expected.
        holder.seeded = seedNote(holder.db!, { ownerId: holder.ownerId! }, { slug: "x" });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.seeded);
      },
    });
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    Object.assign(holder, { db, ownerId: b.id });
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "x" });

    const res = await transfer(app, g.id, a.id, b.id);
    const squatter = await holder.seeded!;

    expect(holder.interleave).toBe("settled");
    expect(res.statusCode).toBe(204);
    expect(candidates).toEqual(["x", "x-2"]);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "x-2" });
    expect(await noteState(db.$client, squatter.id)).toMatchObject({ owner_id: b.id, slug: "x" });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/x`, noteId: n.id },
    ]);
  });
});

describe("#175 delete-all x notes entering the group after the gate", () => {
  it("delete-all: a note created in the group after the gate (group-delete-gated) -> deleted without going through the gate; onGroupAccessChanged exactly once (that note, all members); beforeNoteDeleted only called for the original batch of notes", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks, gates } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, m1, m2] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m1.id, role: "member" }, { userId: m2.id, role: "member" }]);
    const p1 = await seedNote(db, { groupId: g.id });
    const p2 = await seedNote(db, { groupId: g.id });
    state.fire = () => createInGroup(app, g.id, m1.id, "Late");

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(201);
    const late = state.done!.json().id as string;
    expect(res.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteCount(db.$client)).toBe(0);
    expect(sorted(hooks.beforeNoteDeleted.mock.calls.map(c => c[0]))).toEqual(sorted([p1.id, p2.id]));
    expect(gates.every(x => x.release.mock.calls.length === 0)).toBe(true);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([late]);
    expect(sorted(userIds)).toEqual(sorted([a.id, m1.id, m2.id]));
  });

  it("delete-all: a create arriving after lockGroup (group-delete-locked) -> stuck on the FK KEY SHARE -> delete 204, create 404 group_not_found, no orphans", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await seedNote(db, { groupId: g.id });
    state.fire = () => createInGroup(app, g.id, m.id, "Late");

    const res = await deleteAll(app, g.id, a.id);
    const created = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(res.statusCode).toBe(204);
    expect(created.statusCode).toBe(404);
    expect(created.json()).toEqual(CREATE_GROUP_NOT_FOUND_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteCount(db.$client)).toBe(0);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("delete-all: a note copied into the group after the gate (group-delete-gated) -> deleted without going through the gate; onGroupAccessChanged includes that note", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const p1 = await seedNote(db, { groupId: g.id });
    const personal = await seedNote(db, { ownerId: m.id }, { title: "Mine" });
    state.fire = () => copy(app, personal.id, m.id, { groupId: g.id });

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(201);
    const copied = state.done!.json().id as string;
    expect(res.statusCode).toBe(204);
    expect(await notesOfGroup(db.$client, g.id)).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes)).toEqual([{ id: personal.id }]);
    expect(hooks.beforeNoteDeleted.mock.calls.map(c => c[0])).toEqual([p1.id]);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([copied]);
    expect(sorted(userIds)).toEqual(sorted([a.id, m.id]));
  });
});

describe("#175 delete-all x transfer", () => {
  it("after delete-all has opened all gates (group-delete-gated), another admin's transfer completes first -> delete-all 404 not_found, every gate released; the notes survive as transferTo's personal notes", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks, gates } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, a2] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    const p1 = await seedNote(db, { groupId: g.id }, { slug: "one" });
    const p2 = await seedNote(db, { groupId: g.id }, { slug: "two" });
    state.fire = () => transfer(app, g.id, a2.id, a2.id);

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(204);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(sorted(gates.map(x => x.noteId))).toEqual(sorted([p1.id, p2.id]));
    expect(gates.map(x => x.release.mock.calls.length)).toEqual([1, 1]);
    expect(await noteState(db.$client, p1.id)).toMatchObject({ owner_id: a2.id, group_id: null, slug: "one" });
    expect(await noteState(db.$client, p2.id)).toMatchObject({ owner_id: a2.id, group_id: null, slug: "two" });
  });
});

describe("#175 copy/move x group delete", () => {
  it("copy (group note -> personal) holding the source KEY SHARE (note-copy-locked) while delete-all runs -> delete-all's FOR UPDATE waits for the copy to commit -> copy 201 (the copy is the copier's personal note, attachments independent), delete-all 204, source gone", async () => {
    const holder: { app?: FastifyInstance; pool?: Pool; groupId?: string; adminId?: string; del?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => {
        if (p !== "note-copy-locked" || holder.del) return;
        holder.del = deleteAll(holder.app!, holder.groupId!, holder.adminId!);
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.del);
      },
    });
    const { app, db, uploadsDir } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    Object.assign(holder, { app, pool: db.$client, groupId: g.id, adminId: a.id });
    const src = await seedNote(db, { groupId: g.id }, { title: "Src" });
    const u1 = await seedUpload(db, uploadsDir, src.id, a.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));

    // The copy holds KEY SHARE on the source, so the delete-all's FOR UPDATE waits for the copy to commit; the copy reads attachments in its own snapshot and the disk files
    // are only deleted after delete-all commits, so the copy's attachments survive.
    const copied = await copy(app, src.id, m.id);
    const del = await holder.del!;

    expect(holder.interleave).toBe("blocked");
    expect(copied.statusCode).toBe(201);
    expect(copied.json()).toMatchObject({ ownerId: m.id, groupId: null, title: "Src" });
    expect(del.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await db.select({ id: notes.id, ownerId: notes.ownerId }).from(notes)).toEqual([{ id: copied.json().id, ownerId: m.id }]);
    const copyUploads = await db.select({ id: uploads.id }).from(uploads);
    expect(copyUploads).toHaveLength(1);
    expect(copyUploads[0]!.id).not.toBe(u1);
    expect(existsSync(uploadFilePath(uploadsDir, copyUploads[0]!.id))).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, u1))).toBe(false);
  });

  it("same-group copy holding the target groups KEY SHARE (note-copy-target-locked) while a transfer runs -> lockGroup waits -> both complete, no 40P01; the copy is also handed to transferTo", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("note-copy-target-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const src = await seedNote(db, { groupId: g.id }, { title: "Same group" });
    state.fire = () => transfer(app, g.id, a.id, a.id);

    const copied = await copy(app, src.id, m.id, { groupId: g.id });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(copied.statusCode).toBe(201);
    expect(moved.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    const rows = await db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes);
    expect(sorted(rows.map(r => r.id))).toEqual(sorted([src.id, copied.json().id]));
    for (const r of rows) expect(r).toMatchObject({ ownerId: a.id, groupId: null });
  });

  it("move (personal -> G) holding note FOR UPDATE + groups KEY SHARE (note-move-locked) while G is transferred -> lockGroup waits -> move 200, the transfer picks it up; the redirects /n/<mover>/<s> and /g/<g>/<s> both point to it", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, mover] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: mover.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: mover.id }, { slug: "plan" });
    state.fire = () => transfer(app, g.id, a.id, a.id);

    const moved = await move(app, n.id, mover.id, g.id);
    const transferred = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(200);
    expect(transferred.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, slug: "plan" });
    const redirects = await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects);
    expect(redirects.sort((x, y) => x.oldPath.localeCompare(y.oldPath))).toEqual([
      { oldPath: `/g/${g.id}/plan`, noteId: n.id },
      { oldPath: `/n/${mover.handle}/plan`, noteId: n.id },
    ]);
  });
});

describe("#175 group transferred after authorization", () => {
  it("after custom slug PATCH authorization (slugPatchTestHook authorized) the group is transferred -> PATCH 409 conflict; slug not written", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, fire: () => transfer(app, g.id, a.id, a.id) });

    const res = await app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id), payload: { slug: "qux" } });

    expect(state.moved!.statusCode).toBe(204);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(CONFLICT_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, slug: "baz", prev_slug: null });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/baz`, noteId: n.id },
    ]);
  });

  it("token PUT authorized (public-link-authorized), then the group is transferred -> PUT 409 conflict; token still null (the transfer cleared it, and the late PUT didn't reopen a public link on the recipient's personal note)", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, { noteId: n.id, fire: () => transfer(app, g.id, a.id, a.id) });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(a.id) });

    expect(state.moved!.statusCode).toBe(204);
    expect(put.statusCode).toBe(409);
    expect(put.json()).toEqual(CONFLICT_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, public_token: null, public_slug: null });
  });
});

describe("#175 delete-all x upload", () => {
  /** Waits until at least `n` connections on this test DB are waiting on locks, or `other` has finished. */
  async function waitForWaiters(pool: Pool, n: number, other?: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
    let settled = false;
    void other?.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (settled) return "settled";
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n >= n) return "blocked";
      await sleep(20);
    }
    throw new Error(`waitForWaiters(${n}) 逾時（${timeoutMs}ms）`);
  }

  it("delete-all holding L (group notes FOR UPDATE) while uploading to one of them -> the upload transaction's note KEY SHARE read waits for the delete-all commit -> delete 204, upload 404 not_found (reads 0 rows -> TxAbort, the route already unlinked); 0 rows in uploads, no orphan file on disk", async () => {
    // The delete-all is stopped at "L held, the DELETE uploads of `deleteNotesInTx` not finished": another connection first takes FOR UPDATE on that note's existing attachment row u0,
    // so the delete-all's DELETE uploads blocks on u0 (with L already held). An upload sent inside that window: with L, the upload transaction (`insertUploadInTx`)'s `FOR KEY SHARE` read on the
    // notes row conflicts with FOR UPDATE -> waits for the delete-all commit, reads 0 rows -> TxAbort 404 (before the storage quota feature, the INSERT's FK check took the same lock and hit 23503 -> 404);
    // without L the upload succeeds (201), the snapshot of the later DELETE uploads doesn't see it and DELETE notes takes its row with CASCADE - it isn't in the returned uploadIds, so the disk file becomes an orphan.
    // The interleave assertion proves the upload was blocked behind the delete-all's lock (not run before it); the readdir assertion proves that when the upload transaction is rejected
    // (0-row TxAbort; the defence-in-depth FK 23503 likewise) the route unlinks the file first and then returns 404 not_found, so no orphan is left on disk.
    const holder: {
      app?: FastifyInstance; pool?: Pool; noteId?: string; userId?: string; u0?: string;
      up?: Promise<LightMyRequestResponse>; locker?: Promise<void>; t7Blocked?: string; interleave?: string;
    } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async p => {
        if (p !== "group-delete-locked" || holder.locker) return;
        const c = await holder.pool!.connect();
        await c.query("begin");
        await c.query("select id from uploads where id = $1 for update", [holder.u0]);
        // Don't await: let delete-all continue to L and DELETE uploads (stuck on u0), send the upload in that window, release u0 after measuring.
        holder.locker = (async () => {
          try {
            holder.t7Blocked = await waitForWaiters(holder.pool!, 1);
            holder.up = upload(holder.app!, holder.noteId!, holder.userId!);
            holder.interleave = await waitForWaiters(holder.pool!, 2, holder.up);
          } finally {
            await c.query("commit");
            c.release();
          }
        })();
      },
    });
    const { app, db, uploadsDir } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    const u0 = await seedUpload(db, uploadsDir, n.id, a.id);
    Object.assign(holder, { app, pool: db.$client, noteId: n.id, userId: a.id, u0 });

    const del = await deleteAll(app, g.id, a.id);
    await holder.locker;
    const up = await holder.up!;

    expect(holder.t7Blocked).toBe("blocked");
    expect(holder.interleave).toBe("blocked");
    expect(del.statusCode).toBe(204);
    expect(up.statusCode).toBe(404);
    // Byte-for-byte identical to the 404 for "the note never existed" (same shape as the 404 case of uploads.test.ts).
    const missing = await upload(app, "22222222-2222-2222-2222-222222222222", a.id);
    expect(missing.statusCode).toBe(404);
    expect(up.body).toBe(missing.body);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await db.select().from(uploads)).toEqual([]);
    expect(await readdir(uploadsDir)).toEqual([]);
  });
});

describe("#175 alias PUT after authorization, group transferred, recipient reopens the public link", () => {
  // The transfer has cleared the token, so the two-party shape (transfer only) is blocked by the existing predicate `public_token IS NOT NULL`; only the three-party shape where the recipient reopens
  // the token lets the old predicate `group_id IS NULL` through and writes the name chosen by the former member into the recipient's `/p/<B>/...` namespace.
  it("after alias PUT authorization (public-link-authorized): group transferred to B and B reopens the public link -> M's late alias PUT 400 invalid_body; B's note public_slug is still NULL and the token is the one B just opened", async () => {
    const state: {
      noteId?: string;
      fired?: boolean;
      fire?: () => Promise<LightMyRequestResponse>;
      reopen?: () => Promise<LightMyRequestResponse>;
      moved?: LightMyRequestResponse;
      reopened?: LightMyRequestResponse;
    } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (point, ctx) => {
        // Intervenes only the first time (M's alias PUT); B's PUT reopening the token passes through the same point too, so `fired` is set first to let it straight through.
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.fired) return;
        state.fired = true;
        state.moved = await state.fire!();
        state.reopened = await state.reopen!();
      },
    });
    const { app, db } = built;
    const [a, b, m] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await setMemberRole(db, g.id, m.id, await seedRole(db, g.id, "publisher", { canRead: true, canManagePublicLink: true }));
    const n = await seedNote(db, { groupId: g.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, {
      noteId: n.id,
      fire: () => transfer(app, g.id, a.id, b.id),
      reopen: async () => app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(b.id) }),
    });

    const res = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link/slug`, cookies: await cookieOf(m.id), payload: { slug: "m-pick" } });

    expect(state.moved!.statusCode).toBe(204);
    expect(state.reopened!.statusCode).toBe(200);
    const reopenedToken = state.reopened!.json().token as string;
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(ALIAS_REJECTED_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, public_token: reopenedToken, public_slug: null });
  });
});
