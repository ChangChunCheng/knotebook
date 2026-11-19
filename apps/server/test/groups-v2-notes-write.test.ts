/** Interleave tests use groupTestHook to move a personal note into the group with SQL (simulating the move) after authorization and before the write. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { groups, noteLinks, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sharesOf } from "./group-helpers.js";

const ALL = { read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true };

async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, userId: string, payload?: object) {
  return app.inject({ method, url, cookies: await cookieOf(userId), ...(payload ? { payload } : {}) });
}

async function scene(db: Db) {
  const [admin, member, reader, outsider] = await Promise.all(Array.from({ length: 4 }, () => seedUser(db)));
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const g = await seedGroup(db, "Team", [{ userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" }, { userId: reader!.id, role: "member" }]);
  await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
  return { admin: admin!, member: member!, reader: reader!, outsider: outsider!, siteAdmin, g };
}

interface MoverState { point?: GroupRacePoint; noteId?: string; groupId?: string; reopenToken?: string }

function moverHook(db: () => Db, state: MoverState) {
  return async (point: GroupRacePoint, ctx: { noteId?: string }) => {
    if (point !== state.point || ctx.noteId !== state.noteId) return;
    await db().update(notes).set({ ownerId: null, groupId: state.groupId!, publicToken: null, publicSlug: null }).where(eq(notes.id, state.noteId!));
    if (state.reopenToken) await db().update(notes).set({ publicToken: state.reopenToken }).where(eq(notes.id, state.noteId!));
  };
}

describe("#175 POST /api/notes {groupId}", () => {
  it("member (built-in plain member): 201 with and without content, role editor, owner column null, groupId/group set, permissions from the role; personal create is still owner", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const bare = await call(app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, title: "Plan" });
    expect(bare.statusCode).toBe(201);
    expect(bare.json()).toMatchObject({
      role: "editor", ownerId: null, ownerHandle: null, groupId: s.g.id, group: { id: s.g.id, name: "Team" }, slug: "plan",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    const byAdmin = await call(app, "POST", "/api/notes", s.admin.id, { groupId: s.g.id, title: "Plan" });
    expect(byAdmin.json()).toMatchObject({ role: "editor", slug: "plan-2", permissions: { delete: true, managePublicLink: true, changeSlug: true } });
    // Slugs are deduplicated per scope: the group notes "plan"/"plan-2" don't occupy the member's personal scope, hence "plan", not "plan-3".
    const personal = await call(app, "POST", "/api/notes", s.member.id, { title: "Plan" });
    expect(personal.json()).toMatchObject({ role: "owner", slug: "plan", groupId: null, group: null, permissions: ALL });
    expect((await noteState(db.$client, bare.json().id)).owner_id).toBeNull();
  });

  it("content with groupId (exclusion lifted) -> passes the schema (an app without collab gets 400 invalid_body from the deployment gate, the same gate as personal create)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const res = await call(app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, content: "# Hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // The message is the deployment gate's, not the schema's mutual-exclusion message, which would show if the exclusion were still there.
    expect(res.json().error.message).toBe("This deployment cannot create a note with content. Send the request again without content.");
    // The full collab variant is covered in note-create-content.test.ts.
  });

  it("non-member, non-member site admin and missing group -> 404 group_not_found (byte-identical for all three); member lacking the create flag -> 403 forbidden; non-UUID -> 400", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const bodies = [
      await call(app, "POST", "/api/notes", s.outsider.id, { groupId: s.g.id }),
      await call(app, "POST", "/api/notes", s.siteAdmin.id, { groupId: s.g.id }),
      await call(app, "POST", "/api/notes", s.member.id, { groupId: "00000000-0000-4000-8000-00000000dead" }),
    ];
    for (const r of bodies) expect(r.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json().error.code).toBe("group_not_found");
    const reader = await call(app, "POST", "/api/notes", s.reader.id, { groupId: s.g.id });
    expect(reader.statusCode).toBe(403);
    expect(reader.json().error.code).toBe("forbidden");
    // Can edit but lacks the create flag -> also 403: the criterion is can_create, not can_edit (a read-only role can't tell them apart).
    await setMemberRole(db, s.g.id, s.reader.id, await seedRole(db, s.g.id, "Editor", { canRead: true, canEdit: true }));
    const editorNoCreate = await call(app, "POST", "/api/notes", s.reader.id, { groupId: s.g.id });
    expect(editorNoCreate.statusCode).toBe(403);
    expect(editorNoCreate.json().error.code).toBe("forbidden");
    expect((await call(app, "POST", "/api/notes", s.member.id, { groupId: "nope" })).statusCode).toBe(400);
    expect(await db.select().from(notes).where(eq(notes.groupId, s.g.id))).toEqual([]);
  });

  it("group deleted after the membership check (FK 23503) -> 404 group_not_found, no row created", async () => {
    const holder: { db?: Db } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "membership-checked") return;
        await holder.db!.delete(groups).where(eq(groups.id, ctx.groupId!));
      },
    });
    holder.db = built.db;
    const s = await scene(built.db);
    const res = await call(built.app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, title: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("group_not_found");
    expect(await built.db.select().from(notes).where(eq(notes.title, "x"))).toEqual([]);
  });
});

describe("#175 DELETE, shares and public-link permission criteria", () => {
  it("DELETE: group notes follow permissions.delete (plain member 403, non-member 404, admin 204; moved to trash since #181: row remains, deleted_at set)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.member.id)).statusCode).toBe(403);
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.outsider.id)).statusCode).toBe(404);
    expect((await db.select({ deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, gn.id)))[0]?.deletedAt).toBeNull();
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.admin.id)).statusCode).toBe(204);
    const rows = await db.select({ deletedAt: notes.deletedAt, deletedBy: notes.deletedBy }).from(notes).where(eq(notes.id, gn.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).not.toBeNull();
    expect(rows[0]!.deletedBy).toBe(s.admin.id);
  });

  it("shares endpoints: always 403 for group notes (manageShares is always false, even for the admin); leftover row 404; authorization window: authorized as personal owner, then moved into a group -> PUT 409 note_in_group, no share row left", async () => {
    const state: MoverState = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({ groupTestHook: moverHook(() => holder.db!, state) });
    holder.db = built.db;
    const { app, db } = built;
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    for (const [method, url, payload] of [
      ["GET", `/api/notes/${gn.id}/shares`, undefined],
      ["PUT", `/api/notes/${gn.id}/shares`, { email: s.outsider.email, role: "viewer" }],
      ["DELETE", `/api/notes/${gn.id}/shares/${s.outsider.id}`, undefined],
    ] as const) {
      expect((await call(app, method, url, s.admin.id, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
    await seedShare(db, gn.id, s.outsider.id, "editor");
    const leftover = await call(app, "PUT", `/api/notes/${gn.id}/shares`, s.outsider.id, { email: s.member.email, role: "viewer" });
    const missing = await call(app, "PUT", "/api/notes/00000000-0000-4000-8000-00000000dead/shares", s.outsider.id, { email: s.member.email, role: "viewer" });
    expect([leftover.statusCode, leftover.body]).toEqual([404, missing.body]);
    const mine = await seedNote(db, { ownerId: s.member.id });
    Object.assign(state, { point: "share-authorized", noteId: mine.id, groupId: s.g.id });
    const raced = await call(app, "PUT", `/api/notes/${mine.id}/shares`, s.member.id, { email: s.outsider.email, role: "editor" });
    expect(raced.statusCode).toBe(409);
    expect(raced.json().error.code).toBe("note_in_group");
    expect(await sharesOf(db, mine.id)).toEqual([]);
    // The interleave really happened: the note is in the group now (had the hook not fired, the PUT would return 200 and the note would still be personal).
    expect((await noteState(db.$client, mine.id)).group_id).toBe(s.g.id);
  });

  it("public-link: group notes follow managePublicLink (plain member 403, admin 200); alias PUT on a group note is 400 (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    expect((await call(app, "PUT", `/api/notes/${gn.id}/public-link`, s.member.id)).statusCode).toBe(403);
    const on = await call(app, "PUT", `/api/notes/${gn.id}/public-link`, s.admin.id);
    expect(on.statusCode).toBe(200);
    expect(on.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await noteState(db.$client, gn.id)).public_token).toBe(on.json().token);
    const alias = await call(app, "PUT", `/api/notes/${gn.id}/public-link/slug`, s.admin.id, { slug: "team-plan" });
    expect(alias.statusCode).toBe(400);
    expect((await noteState(db.$client, gn.id)).public_slug).toBeNull();
  });

  it("token PUT authorized as personal owner and then moved into a group -> 409 conflict, token not written into the group note; three-way interleave: move -> group reopens token -> stale alias PUT -> 400", async () => {
    const state: MoverState = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({ groupTestHook: moverHook(() => holder.db!, state) });
    holder.db = built.db;
    const { app, db } = built;
    const s = await scene(db);
    const a = await seedNote(db, { ownerId: s.member.id });
    Object.assign(state, { point: "public-link-authorized", noteId: a.id, groupId: s.g.id });
    const put = await call(app, "PUT", `/api/notes/${a.id}/public-link`, s.member.id);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, a.id)).toMatchObject({ group_id: s.g.id, public_token: null });

    // Three-way interleave: authorize (personal owner) -> move into the group (token cleared) -> group admin reopens the token -> stale alias PUT.
    // The old predicate `public_token IS NOT NULL` is true by then; without `group_id IS NULL` it would hit the CHECK and return 500.
    const b = await seedNote(db, { ownerId: s.member.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, { noteId: b.id, reopenToken: "u".repeat(43) });
    const res = await call(app, "PUT", `/api/notes/${b.id}/public-link/slug`, s.member.id, { slug: "my-alias" });
    expect(res.statusCode).toBe(400);
    expect(await noteState(db.$client, b.id)).toMatchObject({ group_id: s.g.id, public_token: "u".repeat(43), public_slug: null });
  });
});

describe("#175 GET /api/notes/:id/backlinks group sources (route wiring)", () => {
  it("group note linking to a personal note: members see the source (groupId set, ownerHandle null); a non-member who only got the target shared does not", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const target = await seedNote(db, { ownerId: s.member.id }, { title: "Target" });
    await seedShare(db, target.id, s.outsider.id, "viewer");
    const src = await seedNote(db, { groupId: s.g.id }, { title: "From group" });
    await db.insert(noteLinks).values({ sourceNoteId: src.id, targetNoteId: target.id });

    const byMember = await call(app, "GET", `/api/notes/${target.id}/backlinks`, s.member.id);
    expect(byMember.statusCode).toBe(200);
    expect(byMember.json().backlinks).toEqual([{ id: src.id, title: "From group", slug: src.slug, ownerHandle: null, groupId: s.g.id }]);

    const byOutsider = await call(app, "GET", `/api/notes/${target.id}/backlinks`, s.outsider.id);
    expect(byOutsider.statusCode).toBe(200);
    expect(byOutsider.json().backlinks).toEqual([]);
  });
});

describe("#186 PATCH /api/notes/:id: a title always requires permissions.edit (with or without slug)", () => {
  async function titleOf(db: Db, noteId: string) {
    const [r] = await db.select({ title: notes.title }).from(notes).where(eq(notes.id, noteId));
    return r!.title;
  }

  it("role with only managePublicLink (no edit): slug alone -> 200; slug + title -> 403 with title and slug unchanged; title alone -> 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    await setMemberRole(db, s.g.id, s.reader.id, await seedRole(db, s.g.id, "LinkMgr", { canRead: true, canManagePublicLink: true }));
    const gn = await seedNote(db, { groupId: s.g.id }, { title: "Original" });

    const slugOnly = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: "linkmgr-slug" });
    expect(slugOnly.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("Original");
    expect((await noteState(db.$client, gn.id)).slug).toBe("linkmgr-slug");

    const both = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: "other-slug", title: "Hijacked" });
    expect(both.statusCode).toBe(403);
    expect(both.json().error.code).toBe("forbidden");
    expect(await titleOf(db, gn.id)).toBe("Original");
    expect((await noteState(db.$client, gn.id)).slug).toBe("linkmgr-slug");

    const nullSlugBoth = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: null, title: "Hijacked" });
    expect(nullSlugBoth.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Original");

    const titleOnly = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { title: "Hijacked" });
    expect(titleOnly.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Original");
  });

  it("role with both edit and changeSlug (built-in admin): slug + title -> 200 and both written; plain member with only edit: slug -> 403 (neither over- nor under-blocked)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id }, { title: "Original" });
    const ok = await call(app, "PATCH", `/api/notes/${gn.id}`, s.admin.id, { slug: "admin-slug", title: "Renamed" });
    expect(ok.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("Renamed");
    expect((await noteState(db.$client, gn.id)).slug).toBe("admin-slug");
    const memberSlug = await call(app, "PATCH", `/api/notes/${gn.id}`, s.member.id, { slug: "member-slug", title: "X" });
    expect(memberSlug.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Renamed");
    const memberTitle = await call(app, "PATCH", `/api/notes/${gn.id}`, s.member.id, { title: "ByMember" });
    expect(memberTitle.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("ByMember");
  });

  it("personal note: owner with slug + title -> 200; shared editor with title -> 200, with slug -> 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const pn = await seedNote(db, { ownerId: s.outsider.id }, { title: "Mine" });
    await seedShare(db, pn.id, s.member.id, "editor");
    const own = await call(app, "PATCH", `/api/notes/${pn.id}`, s.outsider.id, { slug: "mine-slug", title: "Mine 2" });
    expect(own.statusCode).toBe(200);
    expect(await titleOf(db, pn.id)).toBe("Mine 2");
    const ed = await call(app, "PATCH", `/api/notes/${pn.id}`, s.member.id, { title: "Edited" });
    expect(ed.statusCode).toBe(200);
    const edSlug = await call(app, "PATCH", `/api/notes/${pn.id}`, s.member.id, { slug: "x-slug", title: "Edited 2" });
    expect(edSlug.statusCode).toBe(403);
    expect(await titleOf(db, pn.id)).toBe("Edited");
  });
});
