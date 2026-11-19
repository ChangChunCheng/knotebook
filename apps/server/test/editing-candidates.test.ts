import { describe, expect, it, vi } from "vitest";
import { buildCollabTestApp } from "./helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { visibleNoteTargets, visibleNoteTitles, visibleTitlesByIds } from "../src/notes/editing/candidates.js";

describe("visibleNoteTitles", () => {
  it("includes own and shared notes, excludes others' unshared notes", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "me@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "o@example.com", password: "correct-horse-battery" });
    const mine = await ctx.createNote(me.id, "Mine");
    const shared = await ctx.createNote(other.id, "Shared"); await ctx.share(shared.id, me.id, "viewer");
    await ctx.createNote(other.id, "Secret");
    const titles = (await visibleNoteTitles(ctx.db, me.id)).map(t => t.title).sort();
    expect(titles).toEqual(["Mine", "Shared"]);
    expect((await visibleNoteTitles(ctx.db, me.id)).map(t => t.id)).toContain(mine.id);
  });
});

describe("#269 visibleNoteTargets/visibleTitlesByIds", () => {
  it("visible list carries slug/groupId/ownerHandle (a personal note's handle is the owner's, not the reader's)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "t-me@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "t-o@example.com", password: "correct-horse-battery" });
    const mine = await ctx.createNote(me.id, "Mine");
    const shared = await ctx.createNote(other.id, "Shared");
    await ctx.share(shared.id, me.id, "viewer");
    const targets = await visibleNoteTargets(ctx.db, me.id);
    const byId = new Map(targets.map(t => [t.id, t]));
    expect(byId.get(mine.id)).toMatchObject({ title: "Mine", groupId: null, ownerHandle: expect.any(String), slug: expect.any(String) });
    expect(byId.has(shared.id)).toBe(true);
    expect(byId.get(shared.id)?.ownerHandle).not.toBe(byId.get(mine.id)?.ownerHandle);
  });

  it("visibleTitlesByIds: returns only ids that are in the list and visible to the reader; empty set sends no query; non-uuid ids are filtered out (no 22P02)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "t-me2@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "t-o2@example.com", password: "correct-horse-battery" });
    const a = await ctx.createNote(me.id, "A");
    const b = await ctx.createNote(me.id, "B");
    const secret = await ctx.createNote(other.id, "Secret");
    // Visible but not in ids: one each in the shared branch (shared with me) and the grouped branch (readable group) - the `idCond` of each of the three branches has one guarding it.
    const sharedIn = await ctx.createNote(other.id, "SharedIn");
    await ctx.share(sharedIn.id, me.id, "viewer");
    const g = await seedGroup(ctx.db, "G", [{ userId: me.id, role: "member" }]);
    const groupNote = await seedNote(ctx.db, { groupId: g.id }, { title: "GN" });
    expect((await visibleTitlesByIds(ctx.db, me.id, [a.id, secret.id, "not-a-uuid"])).map(t => t.title)).toEqual(["A"]);
    expect((await visibleTitlesByIds(ctx.db, me.id, [b.id])).map(t => t.id)).toEqual([b.id]);
    // Precondition: the SharedIn/GN ones not returned above really are visible to me (not omitted because invisible).
    expect((await visibleNoteTargets(ctx.db, me.id)).map(t => t.id)).toEqual(expect.arrayContaining([sharedIn.id, groupNote.id]));
    const spy = vi.spyOn(ctx.db, "select");
    expect(await visibleTitlesByIds(ctx.db, me.id, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
