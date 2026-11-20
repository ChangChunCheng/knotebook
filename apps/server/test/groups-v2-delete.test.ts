import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { groupMembers, groups, noteLinks, noteRedirects, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, spyCollabHooks } from "./group-helpers.js";
import { seedUpload } from "./copy-helpers.js";

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

const del = async (app: FastifyInstance, groupId: string, userId: string, payload?: unknown) =>
  app.inject({
    method: "DELETE",
    url: `/api/groups/${groupId}`,
    cookies: await cookieOf(userId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const get = async (app: FastifyInstance, url: string, userId: string) => app.inject({ method: "GET", url, cookies: await cookieOf(userId) });

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const NOT_ADMIN_BODY = { error: { code: "not_admin", message: NOT_ADMIN_MESSAGE } };
const SERVER_BUSY_BODY = { error: { code: "server_busy", message: "The server is busy. Try again in a moment." } };
const GROUP_NOT_FOUND_BODY = { error: { code: "not_found", message: "No group with that id." } };

describe("#175 DELETE /api/groups/:id: authorization and body", () => {
  it("authorization matrix, delete mode (payload {mode:'delete'}): member 403, admin and site admin 204; non-member, non-UUID and missing group 404 with byte-identical bodies", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      payload: () => ({ mode: "delete" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("authorization matrix, transfer mode (transferTo = the scenario's built-in admin): member 403, admin and site admin 204; non-member, non-UUID and missing group 404 with byte-identical bodies", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      payload: scene => ({ mode: "transfer", transferTo: scene.admin.id }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("non-UUID route :id (both modes, valid body) -> 404 byte-identical to a missing UUID; no transaction (no hook, no gate)", async () => {
    const recorded: GroupRacePoint[] = [];
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id });
    const bodies: string[] = [];
    for (const id of ["not-a-uuid", `${g.id}x`, g.id.slice(0, 35), randomUUID()]) {
      for (const payload of [{ mode: "delete" }, { mode: "transfer", transferTo: admin.id }]) {
        const res = await del(app, id, admin.id, payload);
        expect(res.statusCode, `${id} ${JSON.stringify(payload)}`).toBe(404);
        bodies.push(res.body);
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(GROUP_NOT_FOUND_BODY);
    expect(recorded).toEqual([]);
    expect(gates).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("invalid body: none, {}, {mode:'bogus'}, {mode:'transfer'} without transferTo, {mode:'delete', transferTo} (extra key), {mode:'transfer', transferTo: 1} -> 400 invalid_body with group and notes untouched; a member sending a bad body still gets 403 (authorization comes before the body)", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [admin, member] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);
    const bad: unknown[] = [undefined, {}, { mode: "bogus" }, { mode: "transfer" }, { mode: "delete", transferTo: admin.id }, { mode: "transfer", transferTo: 1 }];
    for (const payload of bad) {
      const res = await del(app, g.id, admin.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    for (const payload of bad) {
      const res = await del(app, g.id, member.id, payload);
      expect(res.statusCode, `member ${JSON.stringify(payload)}`).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(gates).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("transferTo that is a non-UUID, a non-member, a plain member, a custom role with all seven flags, or a site admin who is not a member -> 409 not_admin with byte-identical bodies for all five; group, notes and members untouched; no hook called", async () => {
    const recorded: GroupRacePoint[] = [];
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const [admin, member, boss, outsider, siteAdmin] = await Promise.all([
      seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db, { isAdmin: true }),
    ]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: boss.id, role: "member" }]);
    const bossRole = await seedRole(db, g.id, "Boss", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await db.update(groupMembers).set({ roleId: bossRole }).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, boss.id)));
    const n = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);

    const bodies: string[] = [];
    for (const transferTo of ["not-a-uuid", outsider.id, member.id, boss.id, siteAdmin.id]) {
      const res = await del(app, g.id, admin.id, { mode: "transfer", transferTo });
      expect(res.statusCode, transferTo).toBe(409);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(NOT_ADMIN_BODY);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toHaveLength(3);
    expect(recorded).toEqual([]);
    expect(gates).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });
});

describe("#175 DELETE /api/groups/:id: transfer", () => {
  it("transfer to another admin: 204 empty body; notes become B's personal notes; GET /api/notes shows them to B (role owner, groupId null) and not to C (plain member); onGroupAccessChanged is called exactly twice: (all notes, members minus B) and (all notes, [B]); beforeNoteDeleted is not called", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const asB = (await get(app, "/api/notes", b.id)).json() as Array<{ id: string; role: string; groupId: string | null; ownerId: string | null }>;
    const mine = asB.filter(x => x.id === n1.id || x.id === n2.id);
    expect(sorted(mine.map(x => x.id))).toEqual(sorted([n1.id, n2.id]));
    for (const x of mine) expect(x).toMatchObject({ role: "owner", groupId: null, ownerId: b.id });
    const asC = (await get(app, "/api/notes", c.id)).json() as Array<{ id: string }>;
    expect(asC.filter(x => x.id === n1.id || x.id === n2.id)).toEqual([]);

    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    const [first, second] = hooks.onGroupAccessChanged.mock.calls;
    expect(sorted(first![0])).toEqual(sorted([n1.id, n2.id]));
    expect(sorted(first![1])).toEqual(sorted([a.id, c.id]));
    expect(sorted(second![0])).toEqual(sorted([n1.id, n2.id]));
    expect(second![1]).toEqual([b.id]);
    expect(hooks.beforeNoteDeleted).not.toHaveBeenCalled();
    expect(gates).toEqual([]);
  });

  it("uppercase route :id and uppercase transferTo -> 204; redirect key uses the lowercase group id; the first revocation batch still filters out transferTo; the hook's groupId is lowercase", async () => {
    const ctxs: Array<{ point: GroupRacePoint; groupId?: string }> = [];
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async (point, ctx) => { ctxs.push({ point, groupId: ctx.groupId }); } });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });

    const res = await del(app, g.id.toUpperCase(), a.id, { mode: "transfer", transferTo: b.id.toUpperCase() });
    expect(res.statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "plan" });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/plan`, noteId: n.id },
    ]);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expect(sorted(hooks.onGroupAccessChanged.mock.calls[0]![1])).toEqual(sorted([a.id, c.id]));
    expect(hooks.onGroupAccessChanged.mock.calls[1]![1]).toEqual([b.id]);
    expect(ctxs).toEqual([{ point: "group-delete-locked", groupId: g.id }, { point: "folder-structure-locked", groupId: g.id }, { point: "group-transfer-slug-candidate", groupId: g.id }]);

    ctxs.length = 0;
    const h = await seedGroup(db, "H", [{ userId: a.id, role: "admin" }]);
    const m = await seedNote(db, { groupId: h.id });
    // Delete-all mode with an uppercase :id: the note is still gated (one beforeNoteDeleted per note) and the hook's groupId is lowercase.
    const gone = await del(app, h.id.toUpperCase(), a.id, { mode: "delete" });
    expect(gone.statusCode).toBe(204);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledTimes(1);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledWith(m.id);
    expect(await db.select().from(notes).where(eq(notes.id, m.id))).toEqual([]);
    expect(ctxs).toEqual([{ point: "group-delete-gated", groupId: h.id }, { point: "group-delete-locked", groupId: h.id }, { point: "folder-structure-locked", groupId: h.id }]);
  });

  it("old /g/ URL: B (transferTo) gets 200 from by-group-path with ownerHandle B and groupId null (redirect hit); A (former admin, not transferTo) and C get 404 with a body byte-identical to a never-existing /g/<random uuid>/<slug>", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const y = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    const asB = await get(app, `/api/notes/by-group-path/${g.id}/plan`, b.id);
    expect(asB.statusCode).toBe(200);
    expect(asB.json()).toMatchObject({ id: y.id, ownerHandle: b.handle, groupId: null, role: "owner" });
    const never = await get(app, `/api/notes/by-group-path/${randomUUID()}/plan`, a.id);
    expect(never.statusCode).toBe(404);
    for (const who of [a, c]) {
      const res = await get(app, `/api/notes/by-group-path/${g.id}/plan`, who.id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(never.body);
    }
  });

  it("transfer clears public links: anonymous GET /api/public/notes/<token> is 200 before and 404 after, body byte-identical to a never-existing token; the note's public upload endpoint /api/public/notes/<token>/uploads/<id> is also 404 after", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const token = "k".repeat(43);
    const n = await seedNote(db, { groupId: g.id }, { publicToken: token, publicWidth: "full" });
    const up = await seedUpload(db, uploadsDir, n.id, a.id);
    const anon = (url: string) => app.inject({ method: "GET", url });
    expect((await anon(`/api/public/notes/${token}`)).statusCode).toBe(200);
    expect((await anon(`/api/public/notes/${token}/uploads/${up}`)).statusCode).toBe(200);

    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    const never = "z".repeat(43);
    const page = await anon(`/api/public/notes/${token}`);
    expect(page.statusCode).toBe(404);
    expect(page.body).toBe((await anon(`/api/public/notes/${never}`)).body);
    const file = await anon(`/api/public/notes/${token}/uploads/${up}`);
    expect(file.statusCode).toBe(404);
    expect(file.body).toBe((await anon(`/api/public/notes/${never}/uploads/${up}`)).body);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, public_token: null, public_slug: null });
    // #297: the transfer clears the public link but keeps the public page width.
    expect((await db.$client.query("select public_width from notes where id = $1", [n.id])).rows).toEqual([{ public_width: "full" }]);
  });

  it("transfer to oneself (caller is the built-in admin) -> 204, caller becomes owner", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null });
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("site admin (non-member) transfers the group to its built-in admin -> 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, site] = await Promise.all([seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    expect((await del(app, g.id, site.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null });
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("transferTo's old redirect is shadowed by a live URL: /n/<B>/x used to point to X (a note B had moved into another group); after the transfer the group note Y gets x in B's scope, so by-path /n/<B>/x returns Y", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const h = await seedGroup(db, "H", [{ userId: b.id, role: "member" }]);
    const x = await seedNote(db, { ownerId: b.id }, { slug: "x" });
    const moved = await app.inject({ method: "POST", url: `/api/notes/${x.id}/move`, cookies: await cookieOf(b.id), payload: { groupId: h.id } });
    expect(moved.statusCode).toBe(200);
    const beforeHit = await get(app, `/api/notes/by-path/${b.handle}/x`, b.id);
    expect(beforeHit.statusCode).toBe(200);
    expect(beforeHit.json().id).toBe(x.id);

    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const y = await seedNote(db, { groupId: g.id }, { slug: "x" });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    expect(await noteState(db.$client, y.id)).toMatchObject({ owner_id: b.id, slug: "x" });
    const after = await get(app, `/api/notes/by-path/${b.handle}/x`, b.id);
    expect(after.statusCode).toBe(200);
    expect(after.json().id).toBe(y.id);
  });
});

describe("#175 DELETE /api/groups/:id: delete all", () => {
  it("delete all: 204; beforeNoteDeleted called once per note of P0 with no release; onGroupAccessChanged not called when L = P0; notes and group gone", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(sorted(gates.map(x => x.noteId))).toEqual(sorted([n1.id, n2.id]));
    for (const gate of gates) expect(gate.release).not.toHaveBeenCalled();
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(await db.select().from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("delete all for a group with attachments and mutual links to another person's personal note: uploads rows and disk files are gone (also 204 if one disk file was already deleted); both note_links p->g1 and g1->p are gone and p remains; p's GET .../backlinks lists g1 before the delete and not after", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const g1 = await seedNote(db, { groupId: g.id });
    const p = await seedNote(db, { ownerId: c.id });
    await db.insert(noteLinks).values([{ sourceNoteId: p.id, targetNoteId: g1.id }, { sourceNoteId: g1.id, targetNoteId: p.id }]);
    const withFile = await seedUpload(db, uploadsDir, g1.id, a.id);
    const fileMissing = await seedUpload(db, uploadsDir, g1.id, a.id, undefined, { noFile: true });
    expect(existsSync(uploadFilePath(uploadsDir, withFile))).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, fileMissing))).toBe(false);
    const backBefore = await get(app, `/api/notes/${p.id}/backlinks`, c.id);
    expect((backBefore.json() as { backlinks: Array<{ id: string }> }).backlinks.map(x => x.id)).toContain(g1.id);

    expect((await del(app, g.id, a.id, { mode: "delete" })).statusCode).toBe(204);

    expect(existsSync(uploadFilePath(uploadsDir, withFile))).toBe(false);
    expect(await db.select().from(uploads).where(inArray(uploads.id, [withFile, fileMissing]))).toEqual([]);
    expect(await db.select().from(noteLinks).where(or(eq(noteLinks.sourceNoteId, g1.id), eq(noteLinks.targetNoteId, g1.id)))).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(eq(notes.id, p.id))).toEqual([{ id: p.id }]);
    expect(await db.select().from(notes).where(eq(notes.id, g1.id))).toEqual([]);
    const backAfter = await get(app, `/api/notes/${p.id}/backlinks`, c.id);
    expect(backAfter.statusCode).toBe(200);
    expect((backAfter.json() as { backlinks: Array<{ id: string }> }).backlinks.map(x => x.id)).not.toContain(g1.id);
  });

  it("delete all, transaction fails -> every gate is released, notes and group untouched, 500", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-locked") throw new Error("boom"); },
    });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toHaveLength(2);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("delete all: the group-delete-gated seam (after the gates open, before the transaction) throws -> 500, every gate released, notes and group untouched", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-gated") throw new Error("boom"); },
    });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toHaveLength(2);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("delete all: one note's beforeNoteDeleted rejects (outside the contract) -> 500, the other opened gates are all released, no transaction, notes and group untouched (allSettled)", async () => {
    const recorded: GroupRacePoint[] = [];
    const released: string[] = [];
    const holder: { bad?: string } = {};
    const hooks = {
      ...spyCollabHooks(),
      beforeNoteDeleted: vi.fn(async (noteId: string) => {
        if (noteId === holder.bad) throw new Error("gate exploded");
        return { release: () => { released.push(noteId); } };
      }),
    };
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });
    const n3 = await seedNote(db, { groupId: g.id });
    holder.bad = n2.id;

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledTimes(3);
    expect(sorted(released)).toEqual(sorted([n1.id, n3.id]));
    expect(recorded).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id, n3.id]))).toHaveLength(3);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("delete all when the group is deleted after the gates and before the transaction -> 404 not_found, all gates released", async () => {
    const holder: { gid?: string; db?: Awaited<ReturnType<typeof buildTestApp>>["db"] } = {};
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => {
        if (p !== "group-delete-gated" || !holder.gid) return;
        await holder.db!.delete(notes).where(eq(notes.groupId, holder.gid));
        await holder.db!.delete(groups).where(eq(groups.id, holder.gid));
      },
    });
    holder.db = db;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id });
    await seedNote(db, { groupId: g.id });
    await seedNote(db, { groupId: g.id });
    holder.gid = g.id;

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(gates).toHaveLength(3);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    holder.gid = undefined;
    const never = await del(app, randomUUID(), a.id, { mode: "delete" });
    expect(res.body).toBe(never.body);
  });
});

describe("#175 DELETE /api/groups/:id: both modes", () => {
  it("empty group: 204 in both modes; onGroupAccessChanged and beforeNoteDeleted not called", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g1 = await seedGroup(db, "Empty1", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const g2 = await seedGroup(db, "Empty2", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    expect((await del(app, g1.id, a.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect((await del(app, g2.id, a.id, { mode: "delete" })).statusCode).toBe(204);
    expect(await db.select().from(groups).where(inArray(groups.id, [g1.id, g2.id]))).toEqual([]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(hooks.beforeNoteDeleted).not.toHaveBeenCalled();
    expect(gates).toEqual([]);
  });

  it("40P01 inside the transaction (hook throws { code: '40P01' } in group-delete-locked) -> 409 server_busy, once for transfer and once for delete all; delete all releases every gate; group and notes untouched", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-locked") throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); },
    });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "one" });
    const n2 = await seedNote(db, { groupId: g.id }, { slug: "two" });
    const before = [await noteState(db.$client, n1.id), await noteState(db.$client, n2.id)];

    const transfer = await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json()).toEqual(SERVER_BUSY_BODY);
    expect(gates).toEqual([]);

    const wipe = await del(app, g.id, a.id, { mode: "delete" });
    expect(wipe.statusCode).toBe(409);
    expect(wipe.json()).toEqual(SERVER_BUSY_BODY);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);

    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect([await noteState(db.$client, n1.id), await noteState(db.$client, n2.id)]).toEqual(before);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });
});
