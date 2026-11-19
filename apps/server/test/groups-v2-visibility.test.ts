import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { groupMembers, noteLinks, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { accessFromListRow, visibleNoteBranches } from "../src/notes/list-query.js";
import { visibleNoteTitles } from "../src/notes/editing/candidates.js";
import { fetchBacklinks, writeNoteLinks } from "../src/notes/links.js";
import { loadNoteAudience, resolveNoteAccess } from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { planOf, seedGroup, seedNote, seedPlannerData, seedRole, seedShare, seedUser, setMemberRole, PLANNER_GROUP_OF_USER1 } from "./group-helpers.js";

function listFor(db: Db, userId: string) {
  const { owned, shared, grouped } = visibleNoteBranches(db, userId);
  return unionAll(owned, shared, grouped).orderBy(desc(notes.updatedAt), desc(notes.id));
}
const idsAndRoles = (rows: Array<{ id: string; role: string }>) => rows.map(r => `${r.id}:${r.role}`).sort();

async function scene(db: Db) {
  const [owner, admin, member, reader, blind, outsider] = await Promise.all(Array.from({ length: 6 }, () => seedUser(db)));
  const g = await seedGroup(db, "G", [
    { userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" },
    { userId: reader!.id, role: "member" }, { userId: blind!.id, role: "member" },
  ]);
  await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
  await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageGroup: true }));
  const personal = await seedNote(db, { ownerId: owner!.id }, { title: "P" });
  await seedShare(db, personal.id, member!.id, "viewer");
  const groupNote = await seedNote(db, { groupId: g.id }, { title: "GN" });
  return { owner: owner!, admin: admin!, member: member!, reader: reader!, blind: blind!, outsider: outsider!, g, personal, groupNote };
}

describe("#175 visibleNoteBranches (shared by list and MCP)", () => {
  it("the three branches are structurally disjoint; grouped requires can_read; role is a CASE; group columns and ownerHandle shape; a leftover share row on a group note doesn't make it visible to a non-member", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await seedShare(db, s.groupNote.id, s.outsider.id, "editor"); // leftover share row on a group note (seeded directly)
    expect(idsAndRoles(await listFor(db, s.owner.id))).toEqual([`${s.personal.id}:owner`]);
    expect(idsAndRoles(await listFor(db, s.admin.id))).toEqual([`${s.groupNote.id}:editor`]);
    expect(idsAndRoles(await listFor(db, s.member.id))).toEqual([`${s.groupNote.id}:editor`, `${s.personal.id}:viewer`].sort());
    expect(idsAndRoles(await listFor(db, s.reader.id))).toEqual([`${s.groupNote.id}:viewer`]);
    expect(await listFor(db, s.blind.id)).toEqual([]);
    expect(await listFor(db, s.outsider.id)).toEqual([]);
    const [row] = await listFor(db, s.admin.id);
    expect(row).toMatchObject({ ownerId: null, ownerHandle: null, groupId: s.g.id, groupName: "G", groupCanDelete: true, groupCanManagePublicLink: true });
    const [mine] = await listFor(db, s.owner.id);
    expect(mine).toMatchObject({ ownerHandle: s.owner.handle, groupId: null, groupName: null, groupCanDelete: null, groupCanManagePublicLink: null });
  });

  it("the TS and SQL derivations agree: for every row, accessFromListRow equals resolveNoteAccess for the same user and note", async () => {
    // SQL side = the grouped branch's `CASE WHEN can_edit ...` (restored to permissions by `accessFromListRow`); TS side = `resolveNoteAccess` via
    // `roleFromGroupFlags` + `groupNotePermissions`. Role fixtures cover: owner, per-user viewer share, built-in admin, built-in plain member, read-only custom,
    // read+edit+delete custom, read+public-link custom, read+delete custom (viewer, but managePublicLink/changeSlug true).
    const { db } = await buildTestApp();
    const s = await scene(db);
    const [deleter, linker, readDeleter] = [await seedUser(db), await seedUser(db), await seedUser(db)];
    await seedGroup(db, "unused", []); // makes group_roles hold another group's rows, so the JOIN condition is proven not to cross groups
    await db.insert(groupMembers).values([
      { groupId: s.g.id, userId: deleter.id, roleId: await seedRole(db, s.g.id, "Editor+Delete", { canRead: true, canEdit: true, canDelete: true }) },
      { groupId: s.g.id, userId: linker.id, roleId: await seedRole(db, s.g.id, "Reader+Link", { canRead: true, canManagePublicLink: true }) },
      // Read + delete without edit: the delete flag must not be tied to edit (if either the TS side or SQL `group_can_delete` ties them, they disagree here).
      { groupId: s.g.id, userId: readDeleter.id, roleId: await seedRole(db, s.g.id, "Reader+Delete", { canRead: true, canDelete: true }) },
    ]);
    // blind/outsider have empty lists on correct code (asserted in the first test); putting them in the loop makes an extra listed row also disagree with resolveNoteAccess.
    for (const user of [s.owner, s.admin, s.member, s.reader, deleter, linker, readDeleter, s.blind, s.outsider]) {
      const rows = await listFor(db, user.id);
      if (user !== s.blind && user !== s.outsider) expect(rows.length, user.id).toBeGreaterThan(0);
      for (const row of rows) {
        const { role, permissions } = await resolveNoteAccess(db, user.id, row.id);
        expect(accessFromListRow(row), `${user.id} × ${row.title}`).toEqual({ role, permissions });
      }
    }
  });

  it("the grouped branch uses group_members_user_idx and notes_group_slug_idx; notes is not Seq Scanned", async () => {
    const { db } = await buildTestApp();
    const { userId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, visibleNoteBranches(db, userId).grouped.toSQL());
    expect(plan).toContain("group_members_user_idx");
    // notes_group_idx was dropped, so notes_group_slug_idx is the only index led by group_id. group_roles' access method isn't asserted:
    // the seed has only 500 role rows, so Seq Scan + Filter can_read is the right plan.
    expect(plan).toContain("notes_group_slug_idx");
    expect(plan).not.toMatch(/Seq Scan on notes\b/);
    expect(PLANNER_GROUP_OF_USER1).toMatch(/^[0-9a-f-]{36}$/); // sanity check: user 1 really has a group (seed shape)
  });
});

describe("#175 the other four visibility queries", () => {
  it("visibleNoteTitles: a read-only role sees group note titles; no-read-flag members and non-members don't", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    const titles = async (userId: string) => (await visibleNoteTitles(db, userId)).map(t => t.title).sort();
    expect(await titles(s.reader.id)).toEqual(["GN"]);
    expect(await titles(s.member.id)).toEqual(["GN", "P"]);
    expect(await titles(s.blind.id)).toEqual([]);
    expect(await titles(s.outsider.id)).toEqual([]);
  });

  it("loadNoteAudience: personal = owner + shares; group = members holding a can_read role (excluding no-read-flag members), never mixes in null", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    expect([...(await loadNoteAudience(db, s.personal.id))].sort()).toEqual([s.owner.id, s.member.id].sort());
    expect([...(await loadNoteAudience(db, s.groupNote.id))].sort()).toEqual([s.admin.id, s.member.id, s.reader.id].sort());
  });

  it("writeNoteLinks: a read-only member can write [[group note]] in their own note; a no-read-flag member and a non-member submitting the same target are silently dropped", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    for (const [user, expected] of [[s.reader, 1], [s.blind, 0], [s.outsider, 0]] as const) {
      const source = await seedNote(db, { ownerId: user.id });
      expect(await writeNoteLinks(db, { sourceNoteId: source.id, userId: user.id, targetIds: [s.groupNote.id], clock: 1 })).toBe("applied");
      const rows = await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, source.id));
      expect(rows.length, user.id).toBe(expected);
    }
  });

  it("fetchBacklinks: group note linking to my note -> members see that link (ownerHandle null, groupId set); no-read-flag members and non-members don't", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await db.insert(noteLinks).values({ sourceNoteId: s.groupNote.id, targetNoteId: s.personal.id });
    expect(await fetchBacklinks(db, s.personal.id, s.member.id)).toEqual([
      { id: s.groupNote.id, title: "GN", slug: s.groupNote.slug, ownerHandle: null, groupId: s.g.id },
    ]);
    expect(await fetchBacklinks(db, s.personal.id, s.blind.id)).toEqual([]);
    expect(await fetchBacklinks(db, s.personal.id, s.outsider.id)).toEqual([]);
  });

  it("a leftover share row on a group note doesn't let non-members see or link to it via backlinks, link writes or candidates", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await seedShare(db, s.groupNote.id, s.outsider.id, "editor"); // leftover share row on a group note (seeded directly)
    const mine = await seedNote(db, { ownerId: s.outsider.id }, { title: "Mine" });
    await db.insert(noteLinks).values({ sourceNoteId: s.groupNote.id, targetNoteId: mine.id });
    expect(await fetchBacklinks(db, mine.id, s.outsider.id)).toEqual([]); // doesn't leak the group note's title/slug/group id
    const source = await seedNote(db, { ownerId: s.outsider.id });
    expect(await writeNoteLinks(db, { sourceNoteId: source.id, userId: s.outsider.id, targetIds: [s.groupNote.id], clock: 1 })).toBe("applied");
    expect(await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, source.id))).toEqual([]);
    expect((await visibleNoteTitles(db, s.outsider.id)).map(t => t.id)).not.toContain(s.groupNote.id);
  });
});
