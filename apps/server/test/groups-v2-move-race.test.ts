/**
 * Tests that must prove a real interleave call `waitForBlockedOrSettled` inside the injection seam and assert "blocked" at the end;
 * the authorization-window tests just `await` one full move request in the seam (sequential is enough there).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { groups, noteRedirects } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, sharesOf, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";

const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });

type RaceState = { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string };

function raceHook(point: GroupRacePoint, state: RaceState, holder: { pool?: Pool }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.second) return;
    state.second = state.fire();
    state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
  };
}

describe("#175 move interleaves (same note twice, delete group, PUT shares)", () => {
  it("same note moved into G1 and G2 at once: the one that gets FOR UPDATE first succeeds; the later one reads owner NULL -> 409 conflict; exactly one redirect row", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const owner = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: owner.id, role: "member" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = () => move(app, n.id, owner.id, g2.id);

    const first = await move(app, n.id, owner.id, g1.id);
    const second = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(first.statusCode).toBe(200);
    expect(first.json().groupId).toBe(g1.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: { code: "conflict", message: "The note's owner or group changed. Reload and try again." } });
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g1.id, slug: "plan" });
    expect(await db.select({ oldPath: noteRedirects.oldPath }).from(noteRedirects)).toEqual([{ oldPath: `/n/${owner.handle}/plan` }]);
  });

  it("deleting an empty group takes the lock first (group-delete-locked) -> the move's KEY SHARE waits for it -> delete 204, move 404 group_not_found; transaction rolls back: note still personal, shares still there, 0 redirect rows", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    await seedShare(db, n.id, c.id, "editor");
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const del = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "delete" } });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(del.statusCode).toBe(204);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "editor" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("move commits first -> delete group in transfer mode: the note becomes transferTo's personal note, and both the move's /n/ redirect and the transfer's /g/ redirect point to it", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    expect((await move(app, n.id, owner.id, g.id)).statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
    });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(await noteState(db.$client, n.id)).toMatchObject({ group_id: null, owner_id: admin.id, slug: "plan" });
    const redirects = await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects);
    expect(redirects.sort((a, b) => a.oldPath.localeCompare(b.oldPath))).toEqual([
      { oldPath: `/g/${g.id}/plan`, noteId: n.id },
      { oldPath: `/n/${owner.handle}/plan`, noteId: n.id },
    ]);
  });

  it("PUT shares takes FOR SHARE first (share-group-checked) -> the move's FOR UPDATE waits for its commit -> the move clears the just-added row; the revocation list includes that person", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const spy = spyCollabHooks();
    const built = await buildTestApp({ collabHooks: spy, groupTestHook: raceHook("share-group-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, late] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    state.fire = () => move(app, n.id, owner.id, g.id);

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/shares`, cookies: await cookieOf(owner.id), payload: { email: late.email, role: "editor" } });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(put.statusCode).toBe(200);
    expect(moved.statusCode).toBe(200);
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = spy.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([n.id]);
    expect([...userIds].sort()).toEqual([late.id, owner.id].sort());
  });

  it("move takes FOR UPDATE first (note-move-locked) -> PUT shares' FOR SHARE waits for its commit -> reads non-NULL group_id -> 409 note_in_group; no shares row", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, late] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    state.fire = async () =>
      app.inject({ method: "PUT", url: `/api/notes/${n.id}/shares`, cookies: await cookieOf(owner.id), payload: { email: late.email, role: "editor" } });

    const moved = await move(app, n.id, owner.id, g.id);
    const put = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(200);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("note_in_group");
    expect(await sharesOf(db, n.id)).toEqual([]);
  });
});

describe("#175 move x member changes (remove, downgrade)", () => {
  // Member change takes `lockGroup` first (group-members-checked) -> the move's KEY SHARE waits for its commit -> reads the changed membership.
  // The reverse order (move first, member change waits) is not asserted on the response: after the move commits, the route re-reads the note outside the transaction
  // and races the member change's commit, so the response may be 200 or 404 (natural timing gives 200, forcing the change to commit first gives 404). Only the
  // deterministic part is asserted: the final state is "move first, change second" and the change's revocation list includes the moved-in note.
  // Without KEY SHARE the move reads the pre-commit membership and passes (the UPDATE's FK then waits, so the interleave still shows "blocked"), then commits anyway
  // and the note enters the group: the downgrade case returns 200 and the removal case 404 `not_found` (the caller is no longer a member at the post-commit re-read).
  it("removing a member takes the lock first -> the move waits on the groups row lock -> removal 204, move 404 group_not_found; note still the caller's personal note, shares still there, 0 redirect rows", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    await seedShare(db, n.id, c.id, "editor");
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const removed = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id) });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(before).toMatchObject({ owner_id: owner.id, group_id: null });
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "editor" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("downgrading to a role without can_create takes the lock first -> the move waits on the groups row lock -> role change 200, move 404 group_not_found; note still personal", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, g.id, "Reader", { canRead: true });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const demoted = await app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id), payload: { roleId: reader },
    });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(before).toMatchObject({ owner_id: owner.id, group_id: null });
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("move holds KEY SHARE first (note-move-locked) -> member removal's lockGroup waits for its commit -> removal 204, note ends up in the group; the removal's revocation list includes this note and the owner", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const spy = spyCollabHooks();
    const built = await buildTestApp({ collabHooks: spy, groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    // Existing group note: the removal's revocation list always contains it and the move's never does, which identifies the removal call among the two
    // onGroupAccessChanged calls (the move's call is ([n], [owner]) and contains n and owner too, so it can't be used).
    const existing = await seedNote(db, { groupId: g.id });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = async () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id) });

    // The move's response code is not asserted: after its commit the route re-reads the note outside the transaction and races the removal's commit (200 or 404, see above).
    await move(app, n.id, owner.id, g.id);
    const removed = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id });
    // Safety property: a removed member must not stay on the just-moved-in note. Relies on `groupNoteIdsQuery` reading in a separate statement after `lockGroup`
    // (only under READ COMMITTED does it see the just-committed move).
    const removalCalls = spy.onGroupAccessChanged.mock.calls.filter(([noteIds]) => noteIds.includes(existing.id));
    expect(removalCalls).toHaveLength(1);
    const [noteIds, userIds] = removalCalls[0]!;
    expect([...noteIds].sort()).toEqual([existing.id, n.id].sort());
    expect(userIds).toEqual([owner.id]);
  });
});

describe("#175 move x group rename", () => {
  it("renaming the group is not blocked while the move holds groups KEY SHARE (note-move-locked): the rename settles before the move is released and returns 200; the move returns 200", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = async () =>
      app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: "Renamed" } });

    const moved = await move(app, n.id, owner.id, g.id);
    const renamed = await state.second!;

    // Renaming is a non-key UPDATE (`FOR NO KEY UPDATE`), compatible with KEY SHARE; changing the move's lock to `FOR SHARE` would make this "blocked".
    expect(state.interleave).toBe("settled");
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed");
    expect(moved.statusCode).toBe(200);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id });
    expect(await db.select({ name: groups.name }).from(groups).where(eq(groups.id, g.id))).toEqual([{ name: "Renamed" }]);
  });
});

describe("#175 note moved after authorization", () => {
  it("token PUT: note moved away after authorization (public-link-authorized) -> PUT 409 conflict; token stays NULL", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    Object.assign(state, { noteId: n.id, fire: () => move(app, n.id, owner.id, g.id) });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(owner.id) });

    expect(state.moved!.statusCode).toBe(200);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ group_id: g.id, public_token: null });
  });

  it("alias PUT: note moved away after authorization and the group reopened a token -> 400 invalid_body (not 500), public_slug stays NULL", async () => {
    const state: { noteId?: string; userId?: string; groupId?: string; moved?: LightMyRequestResponse; reopened?: LightMyRequestResponse } = {};
    const holder: { app?: FastifyInstance } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await move(holder.app!, state.noteId!, state.userId!, state.groupId!);
        // After the move into the group, a member with managePublicLink (here the owner, the group's built-in admin) reopens the token, so the alias UPDATE's
        // `public_token IS NOT NULL` is true and only `group_id IS NULL` keeps it from hitting the CHECK (500).
        state.reopened = await holder.app!.inject({ method: "PUT", url: `/api/notes/${state.noteId}/public-link`, cookies: await cookieOf(state.userId!) });
      },
    });
    holder.app = built.app;
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { publicToken: "a".repeat(43) });
    Object.assign(state, { noteId: n.id, userId: owner.id, groupId: g.id });

    const res = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link/slug`, cookies: await cookieOf(owner.id), payload: { slug: "alias" } });

    expect(state.moved!.statusCode).toBe(200);
    expect(state.reopened!.statusCode).toBe(200);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    const after = await noteState(db.$client, n.id);
    expect(after).toMatchObject({ group_id: g.id, public_slug: null });
    expect(after.public_token).not.toBeNull();
  });

  it("custom slug PATCH: note moved away after authorization (slugPatchTestHook authorized) -> 409 conflict; slug not written, the move's redirect remains", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, fire: () => move(app, n.id, owner.id, g.id) });

    const res = await app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(owner.id), payload: { slug: "qux" } });

    expect(state.moved!.statusCode).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "baz", group_id: g.id, prev_slug: null });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/n/${owner.handle}/baz`, noteId: n.id },
    ]);
  });
});
