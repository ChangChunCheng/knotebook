/** Redirect rows are inserted with seedRedirect (the only production path that writes redirects is move); "moved into a group" is simulated with SQL. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { noteRedirects, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SlugPatchTestHook } from "../src/notes/tx/patch-slug.js";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, noteState, seedGroup, seedNote, seedRedirect, seedRole, seedShare, seedUser, setMemberRole, waitForBlockedOrSettled,
} from "./group-helpers.js";

async function patch(app: FastifyInstance, noteId: string, userId: string, payload: object) {
  return app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: await cookieOf(userId), payload });
}
async function byPath(app: FastifyInstance, handle: string, slug: string, userId: string) {
  return app.inject({ method: "GET", url: `/api/notes/by-path/${handle}/${slug}`, cookies: await cookieOf(userId) });
}
async function redirectRow(db: Db, oldPath: string) {
  return (await db.select().from(noteRedirects).where(eq(noteRedirects.oldPath, oldPath)))[0];
}

describe("#175 PATCH permissions", () => {
  it("group: read-only role title edit 403, plain member title edit 200 but slug edit 403, admin slug edit 200; personal: editor slug edit 403, owner 200", async () => {
    const { app, db } = await buildTestApp();
    const [admin, member, reader, owner, editor] = await Promise.all(Array.from({ length: 5 }, () => seedUser(db)));
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: reader.id, role: "member" }]);
    await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    const gn = await seedNote(db, { groupId: g.id });
    expect((await patch(app, gn.id, reader.id, { title: "x" })).statusCode).toBe(403);
    expect((await patch(app, gn.id, member.id, { title: "Member Title" })).json()).toMatchObject({ title: "Member Title", ownerHandle: null, groupId: g.id, role: "editor" });
    expect((await patch(app, gn.id, member.id, { slug: "custom" })).statusCode).toBe(403);
    expect((await patch(app, gn.id, admin.id, { slug: "custom" })).json()).toMatchObject({ slug: "custom", slugIsCustom: true, groupId: g.id });
    const mine = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, mine.id, editor.id, "editor");
    expect((await patch(app, mine.id, editor.id, { slug: "nope" })).statusCode).toBe(403);
    expect((await patch(app, mine.id, owner.id, { slug: "yes" })).json()).toMatchObject({ slug: "yes", ownerHandle: owner.handle });
  });

  it("group editor title change: auto slug is deduplicated in the group scope - a same-named personal note of the same person adds no -2, another same-named note in the group adds -2; a real race hitting notes_group_slug_idx retries successfully", async () => {
    const holder: { db?: Db; groupId?: string; armed?: boolean } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async candidate => {
        if (!holder.armed) return;
        holder.armed = false; // race-insert only once so the first UPDATE round hits notes_group_slug_idx
        await holder.db!.insert(notes).values({ groupId: holder.groupId!, title: "racer", slug: candidate });
      },
    });
    Object.assign(holder, { db: built.db });
    const { app, db } = built;
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: member.id, role: "member" }]);
    holder.groupId = g.id;
    await seedNote(db, { ownerId: member.id }, { slug: "roadmap" });
    const a = await seedNote(db, { groupId: g.id });
    expect((await patch(app, a.id, member.id, { title: "Roadmap" })).json().slug).toBe("roadmap");
    const b = await seedNote(db, { groupId: g.id });
    expect((await patch(app, b.id, member.id, { title: "Roadmap" })).json().slug).toBe("roadmap-2");
    const c = await seedNote(db, { groupId: g.id });
    holder.armed = true;
    const raced = await patch(app, c.id, member.id, { title: "Roadmap" });
    expect(raced.statusCode).toBe(200);
    expect(raced.json().slug).toBe("roadmap-4"); // roadmap-3 was taken by the racing insert; the re-probe lands on -4
  });

  it("custom slug of a group note colliding with another note in the same group -> 409 slug_taken (recognizes notes_group_slug_idx); same name in another group or a personal note doesn't count", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: admin.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "taken", slugIsCustom: true });
    await seedNote(db, { groupId: h.id }, { slug: "elsewhere", slugIsCustom: true });
    await seedNote(db, { ownerId: admin.id }, { slug: "mine", slugIsCustom: true });
    const n = await seedNote(db, { groupId: g.id });
    const clash = await patch(app, n.id, admin.id, { slug: "taken" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("slug_taken");
    expect((await patch(app, n.id, admin.id, { slug: "elsewhere" })).json()).toMatchObject({ slug: "elsewhere", groupId: g.id });
    expect((await patch(app, n.id, admin.id, { slug: "mine" })).json()).toMatchObject({ slug: "mine", groupId: g.id });
  });

  it("moved into a group after authorization and before the UPDATE (caller is a member of that group) -> 409 conflict; title not written", async () => {
    const holder: { db?: Db; noteId?: string; groupId?: string } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async () => {
        if (!holder.noteId) return;
        const noteId = holder.noteId;
        holder.noteId = undefined;
        await holder.db!.update(notes).set({ ownerId: null, groupId: holder.groupId! }).where(eq(notes.id, noteId));
      },
    });
    holder.db = built.db;
    const { app, db } = built;
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id }, { title: "Before Move" });
    Object.assign(holder, { noteId: n.id, groupId: g.id });
    const res = await patch(app, n.id, u.id, { title: "Moved Meanwhile" });
    // #175: the UPDATE carries the authorization-time owner (owner_id = u) as its scope predicate; the row has moved into a group -> 0 rows -> row exists -> 409.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    const [row] = await db.select({ title: notes.title, groupId: notes.groupId }).from(notes).where(eq(notes.id, n.id));
    expect(row).toEqual({ title: "Before Move", groupId: g.id });
  });
});

describe("#175 writing prev deletes the redirect at the same path", () => {
  it("N1 moved into a group leaves a /n/h/c15 redirect; N2 takes c15 and then renames to custom -> prev=c15 and the redirect is deleted -> /n/h/c15 resolves to N2", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "c15", slugIsCustom: true });
    await seedRedirect(db, `/n/${u.handle}/c15`, n1.id);
    const n2 = await seedNote(db, { ownerId: u.id });
    expect((await patch(app, n2.id, u.id, { slug: "c15" })).statusCode).toBe(200); // a live URL wins over a redirect
    expect(await redirectRow(db, `/n/${u.handle}/c15`)).toBeDefined(); // auto -> custom writes no prev and deletes nothing
    expect((await patch(app, n2.id, u.id, { slug: "c15b" })).json().prevSlug).toBe("c15");
    expect(await redirectRow(db, `/n/${u.handle}/c15`)).toBeUndefined();
    expect((await byPath(app, u.handle, "c15", u.id)).json().id).toBe(n2.id);
  });

  it("group scope does not delete redirects (DELETE is only issued in personal scope): an admin changing a group note's custom slug writes prev, but the /n/<admin>/<old slug> redirect remains", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id }, { slug: "gold", slugIsCustom: true });
    const mine = await seedNote(db, { ownerId: admin.id });
    await seedRedirect(db, `/n/${admin.handle}/gold`, mine.id);
    expect((await patch(app, gn.id, admin.id, { slug: "gold2" })).json()).toMatchObject({ slug: "gold2", prevSlug: "gold", groupId: g.id });
    expect(await redirectRow(db, `/n/${admin.handle}/gold`)).toMatchObject({ noteId: mine.id });
  });

  it("wrong-delete counterexample: old row is auto and prev is kept unchanged -> the newer redirect is not deleted", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n3 = await seedNote(db, { ownerId: u.id }, { slug: "auto3", prevSlug: "pp" });
    const n4 = await seedNote(db, { groupId: g.id }, { slug: "pp" });
    await seedRedirect(db, `/n/${u.handle}/pp`, n4.id);
    expect((await patch(app, n3.id, u.id, { slug: "r3" })).json().prevSlug).toBe("pp"); // old row is auto -> prev unchanged
    expect(await redirectRow(db, `/n/${u.handle}/pp`)).toBeDefined();
    expect((await byPath(app, u.handle, "pp", u.id)).json().id).toBe(n4.id);
  });

  it("concurrency: A renames N to custom foo and holds the row lock; B renames to bar and is blocked; after A commits B reads the overwritten custom version -> prev=foo and /n/h/foo is deleted", async () => {
    const state: { noteId?: string; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { app?: FastifyInstance; db?: Db; userId?: string } = {};
    const hook: SlugPatchTestHook = async (point, ctx) => {
      if (point !== "slug-written" || ctx.noteId !== state.noteId || state.second) return;
      state.second = patch(holder.app!, state.noteId!, holder.userId!, { slug: "bar" });
      state.interleave = await waitForBlockedOrSettled(holder.db!.$client, state.second);
    };
    const built = await buildTestApp({ slugPatchTestHook: hook });
    Object.assign(holder, { app: built.app, db: built.db });
    const { app, db } = built;
    const u = await seedUser(db);
    holder.userId = u.id;
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "a0" });
    const other = await seedNote(db, { groupId: g.id });
    await seedRedirect(db, `/n/${u.handle}/foo`, other.id);
    state.noteId = n.id;
    expect((await patch(app, n.id, u.id, { slug: "foo" })).statusCode).toBe(200);
    const b = await state.second!;
    expect(state.interleave).toBe("blocked");
    expect(b.json()).toMatchObject({ slug: "bar", prevSlug: "foo" });
    expect(await redirectRow(db, `/n/${u.handle}/foo`)).toBeUndefined();
    expect((await byPath(app, u.handle, "foo", u.id)).json().id).toBe(n.id);
  });

  it("moved into a group after authorization -> 409 conflict; slug not written, the redirect left by the move is kept; deleted after authorization -> 404", async () => {
    const state: { noteId?: string; groupId?: string; handle?: string; mode?: "move" | "delete" } = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId) return;
        if (state.mode === "delete") {
          await holder.db!.delete(notes).where(eq(notes.id, state.noteId!));
          return;
        }
        await holder.db!.update(notes).set({ ownerId: null, groupId: state.groupId!, prevSlug: null }).where(eq(notes.id, state.noteId!));
        await holder.db!.insert(noteRedirects).values({ oldPath: `/n/${state.handle}/baz`, noteId: state.noteId!, expiresAt: new Date(Date.now() + 86_400_000) });
      },
    });
    holder.db = built.db;
    const { app, db } = built;
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, groupId: g.id, handle: u.handle, mode: "move" });
    const res = await patch(app, n.id, u.id, { slug: "qux" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "baz", group_id: g.id });
    expect(await redirectRow(db, `/n/${u.handle}/baz`)).toBeDefined();
    const gone = await seedNote(db, { ownerId: u.id }, { slugIsCustom: true });
    Object.assign(state, { noteId: gone.id, mode: "delete" });
    expect((await patch(app, gone.id, u.id, { slug: "zz" })).statusCode).toBe(404);
  });
});

describe("#175 PATCH title-only: note really moved into a group the caller is not in after authorization", () => {
  const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };

  it("shared editor changes the title; inside slugUpdateTestHook (before the title-only UPDATE) the owner moves the note into another group via POST .../move -> 409 conflict, title not written, response does not contain the group name", async () => {
    const holder: { app?: FastifyInstance; fire?: () => Promise<void> } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async () => {
        if (!holder.fire) return;
        const f = holder.fire;
        holder.fire = undefined;
        await f();
      },
    });
    holder.app = built.app;
    const { app, db } = built;
    const [owner, ed] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "SecretGroupName", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { title: "Original" });
    await seedShare(db, n.id, ed.id, "editor");
    let moveStatus: number | undefined;
    holder.fire = async () => {
      const r = await holder.app!.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(owner.id), payload: { groupId: g.id } });
      moveStatus = r.statusCode;
    };
    const res = await patch(app, n.id, ed.id, { title: "x" });
    expect(moveStatus).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(res.body).not.toContain("SecretGroupName");
    expect(res.body).not.toContain(g.id);
    const [row] = await db.select({ title: notes.title, groupId: notes.groupId, ownerId: notes.ownerId }).from(notes).where(eq(notes.id, n.id));
    expect(row).toEqual({ title: "Original", groupId: g.id, ownerId: null });
  });

  it("deleted after authorization -> 404 not_found (the other branch of the 0-row split; ownershipChanged can't read the row)", async () => {
    const holder: { db?: Db; noteId?: string } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async () => {
        if (!holder.noteId) return;
        const noteId = holder.noteId;
        holder.noteId = undefined;
        await holder.db!.delete(notes).where(eq(notes.id, noteId));
      },
    });
    holder.db = built.db;
    const { app, db } = built;
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    holder.noteId = n.id;
    const res = await patch(app, n.id, u.id, { title: "Gone" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });
});
