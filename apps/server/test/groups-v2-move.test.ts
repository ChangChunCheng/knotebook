import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import type { FastifyInstance } from "fastify";
import { validateSlug } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteLinks, noteRedirects, noteStates, uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sharesOf, spyCollabHooks } from "./group-helpers.js";

const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };

const move = async (app: FastifyInstance, noteId: string, userId: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

const get = async (app: FastifyInstance, url: string, userId: string) => app.inject({ method: "GET", url, cookies: await cookieOf(userId) });

describe("#175 POST /api/notes/:id/move", () => {
  it("personal note moved into a group: 200 with the new DTO shape; DB clears shares/token/alias/prev and owner, keeps slug and slug_is_custom, leaves updated_at alone; exactly one redirect row; AI records, links, uploads and note_states follow the UUID", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    const [owner, c, admin] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true, prevSlug: "old", publicToken: "t".repeat(43), publicSlug: "alias", publicWidth: "full" });
    const other = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, c.id, "editor");
    await db.insert(noteAiEdits).values({ noteId: n.id, userId: owner.id, op: "append" });
    await db.insert(noteLinks).values([{ sourceNoteId: n.id, targetNoteId: other.id }, { sourceNoteId: other.id, targetNoteId: n.id }]);
    const [up] = await db.insert(uploads).values({ noteId: n.id, uploaderId: owner.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    const before = await noteState(db.$client, n.id);

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: n.id, groupId: g.id, ownerId: null, ownerHandle: null, role: "editor", slug: "plan", slugIsCustom: true, prevSlug: null,
      group: { id: g.id, name: "G" }, permissions: MEMBER_PERMS,
    });
    expect(await noteState(db.$client, n.id)).toEqual({
      owner_id: null, group_id: g.id, slug: "plan", prev_slug: null, slug_is_custom: true, public_token: null, public_slug: null,
      updated_at: before.updated_at,
    });
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/n/${owner.handle}/plan`, noteId: n.id },
    ]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, n.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(eq(noteLinks.targetNoteId, n.id))).toHaveLength(1);
    expect(await db.select({ noteId: uploads.noteId }).from(uploads).where(eq(uploads.id, up!.id))).toEqual([{ noteId: n.id }]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, n.id))).toHaveLength(1);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = spy.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([n.id]);
    expect([...userIds].sort()).toEqual([c.id, owner.id].sort());
    // #297: the move clears token and alias but keeps the public page width (reused when published again).
    expect((await db.$client.query("select public_width from notes where id = $1", [n.id])).rows).toEqual([{ public_width: "full" }]);
  });

  it("100-char custom slug colliding in the group -> at most 60 chars, ends in -2, slug_is_custom stays true, updated_at unchanged, the old /n/ URL redirects to it", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const base = "b".repeat(100);
    await seedNote(db, { groupId: g.id }, { slug: base });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: base, slugIsCustom: true });
    const before = await noteState(db.$client, n.id);

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    const expected = nextSlugCandidate(base, 2);
    expect(res.json().slug).toBe(expected);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
    expect(expected.endsWith("-2")).toBe(true);
    expect(validateSlug(expected)).toBeNull();
    // A collision rename (-2) must not touch updated_at either: docs/known-limitations.md (`list_notes` pagination) and `LIST_NOTES_DESCRIPTION` both promise
    // that a note moved into a group keeps its position; the move path is what makes that true (the previous test is the non-colliding shape).
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: expected, slug_is_custom: true, group_id: g.id, updated_at: before.updated_at });
    const old = await get(app, `/api/notes/by-path/${owner.handle}/${base}`, owner.id);
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ id: n.id, groupId: g.id, slug: expected });
  });

  it("slug collision retry (note-move-slug-candidate): a same-name group note appears after the probe and before the write -> savepoint rolls back, the re-probe gets -2; the rest of the transaction commits", async () => {
    const state: { candidates: string[] } = { candidates: [] };
    const holder: { groupId?: string; db?: Db } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "note-move-slug-candidate") return;
        state.candidates.push(ctx.slug!);
        // Another connection (pool) commits a group note with the same slug first, so the move's UPDATE hits notes_group_slug_idx.
        if (state.candidates.length === 1) await seedNote(holder.db!, { groupId: holder.groupId! }, { slug: ctx.slug! });
      },
    });
    const { app, db } = built;
    holder.db = db;
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    holder.groupId = g.id;
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true });
    await seedShare(db, n.id, c.id, "viewer");

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(state.candidates).toEqual(["plan", "plan-2"]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "plan-2", groupId: g.id });
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "plan-2", group_id: g.id, owner_id: null, slug_is_custom: true });
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(await db.select({ oldPath: noteRedirects.oldPath }).from(noteRedirects)).toEqual([{ oldPath: `/n/${owner.handle}/plan` }]);
  });

  it("old URL opened with an uppercase handle after the move -> redirect hit, 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true });
    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    const upper = await get(app, `/api/notes/by-path/${owner.handle.toUpperCase()}/plan`, owner.id);
    expect(owner.handle.toUpperCase()).not.toBe(owner.handle);
    expect(upper.statusCode).toBe(200);
    expect(upper.json()).toMatchObject({ id: n.id, groupId: g.id });
    const byGroup = await get(app, `/api/notes/by-group-path/${g.id}/plan`, owner.id);
    expect(byGroup.statusCode).toBe(200);
    expect(byGroup.json()).toMatchObject({ id: n.id, groupId: g.id });
  });

  it("public link invalid immediately: anonymous read with the old token is 404; the move does not consume the publicLink limiter", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ publicLink: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) }) });
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const token = "p".repeat(43);
    const n = await seedNote(db, { ownerId: owner.id }, { publicToken: token });
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);

    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(404);
    const reopen = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(owner.id) });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().token).not.toBe(token);
  });

  it("authorization: per-user editor/viewer share -> 403 forbidden; stranger -> 404 not_found; group note (any role) -> 403; missing note -> 404", async () => {
    const { app, db } = await buildTestApp();
    const [owner, ed, vw, stranger, admin, member] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: ed.id, role: "member" }, { userId: vw.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, ed.id, "editor");
    await seedShare(db, n.id, vw.id, "viewer");
    const gn = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);

    for (const who of [ed, vw]) {
      const res = await move(app, n.id, who.id, { groupId: g.id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    const strangerRes = await move(app, n.id, stranger.id, { groupId: g.id });
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.json()).toEqual({ error: { code: "not_found", message: "No note with that id." } });
    for (const who of [admin, member]) {
      const res = await move(app, gn.id, who.id, { groupId: g.id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    const missing = await move(app, "00000000-0000-4000-8000-000000000000", owner.id, { groupId: g.id });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(strangerRes.body);
    const badId = await move(app, "not-a-uuid", owner.id, { groupId: g.id });
    expect(badId.statusCode).toBe(404);
    expect(badId.body).toBe(strangerRes.body);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toHaveLength(2);
  });

  it("target: non-UUID, missing, non-member, or member whose role lacks can_create -> 404 group_not_found with byte-identical bodies for all four; note untouched", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const readOnly = await seedGroup(db, "ReadOnly", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, readOnly.id, "Reader", { canRead: true });
    await setMemberRole(db, readOnly.id, owner.id, reader);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true, publicToken: "q".repeat(43) });
    await seedShare(db, n.id, c.id, "viewer");
    const before = await noteState(db.$client, n.id);

    const bodies: string[] = [];
    for (const groupId of ["not-a-uuid", "00000000-0000-4000-8000-00000000abcd", notMine.id, readOnly.id]) {
      const res = await move(app, n.id, owner.id, { groupId });
      expect(res.statusCode, groupId).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "viewer" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("strict body: extra key -> 400 invalid_body; missing groupId -> 400; non-string groupId -> 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    const before = await noteState(db.$client, n.id);
    for (const payload of [{ groupId: g.id, extra: 1 }, {}, { groupId: 42 }, { groupId: null }]) {
      const res = await move(app, n.id, owner.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await noteState(db.$client, n.id)).toEqual(before);
  });

  it("GET /api/notes after the move: the note is in the group branch (role editor, group set) and not in the owner's personal branch", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    const list = (await get(app, "/api/notes", owner.id)).json() as Array<{ id: string; ownerId: string | null; role: string; group: unknown }>;
    const rows = list.filter(r => r.id === n.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: null, role: "editor", group: { id: g.id, name: "G" } });
  });

  it("create-only role (can create, cannot edit) moving in -> 200 with role viewer and permissions.edit false; onGroupAccessChanged list includes the owner (re-verification downgrades their collab connection to read-only)", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const contributor = await seedRole(db, g.id, "Contributor", { canRead: true, canCreate: true });
    await setMemberRole(db, g.id, owner.id, contributor);
    const n = await seedNote(db, { ownerId: owner.id });

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      groupId: g.id, ownerId: null, role: "viewer",
      permissions: { read: true, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(spy.onGroupAccessChanged.mock.calls[0]).toEqual([[n.id], [owner.id]]);
    // That the collab connection is really downgraded to read-only (provider gets viewer) is verified with a real connection by the create-only test at the end of groups-v2-revocation.test.ts.
  });
});
