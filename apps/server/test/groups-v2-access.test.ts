/** A group note's role is never owner; a non-member site admin has no privilege on notes; residual per-person share rows on group notes grant nothing. */
import { describe, expect, it } from "vitest";
import type { NotePermissions } from "@knotebook/shared";
import {
  NO_PERMISSIONS, OWNER_PERMISSIONS, accessQuery, resolveNoteAccess, resolveRole, roleFromGroupFlags, type NoteAccess,
} from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { planOf, seedGroup, seedNote, seedPlannerData, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const P = (o: Partial<NotePermissions>): NotePermissions => ({ ...NO_PERMISSIONS, ...o });
const NONE: NoteAccess = { role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS };

describe("#175 resolveNoteAccess", () => {
  it("matrix: personal owner / per-person editor / viewer / stranger / group member; group x built-in admin / regular member / read-only custom / delete-only custom / public-link-only custom / no-read custom / non-member; non-member site admin / site admin who is a member; nonexistent; non-UUID", async () => {
    const { db } = await buildTestApp();
    const [owner, ed, vw, stranger, admin, member, reader, blind, deleter, publisher] = await Promise.all(
      Array.from({ length: 10 }, () => seedUser(db)),
    );
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const memberSiteAdmin = await seedUser(db, { isAdmin: true });
    const personal = await seedNote(db, { ownerId: owner!.id });
    await seedShare(db, personal.id, ed!.id, "editor");
    await seedShare(db, personal.id, vw!.id, "viewer");
    const g = await seedGroup(db, "G", [
      { userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" },
      { userId: reader!.id, role: "member" }, { userId: blind!.id, role: "member" },
      { userId: deleter!.id, role: "member" }, { userId: publisher!.id, role: "member" },
      { userId: memberSiteAdmin.id, role: "member" },
    ]);
    await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    // No read flag but with manage-members ticked (neither manage flag implies read) - still none on the note
    await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageMembers: true }));
    // Two roles with delete and public link independent of each other: makes delete and managePublicLink/changeSlug distinguishable in the matrix,
    // and also tells apart "treating delete as edit"
    await setMemberRole(db, g.id, deleter!.id, await seedRole(db, g.id, "Del", { canRead: true, canDelete: true }));
    await setMemberRole(db, g.id, publisher!.id, await seedRole(db, g.id, "Pub", { canRead: true, canManagePublicLink: true }));
    const groupNote = await seedNote(db, { groupId: g.id });

    const cases: Array<[string, string, string, NoteAccess]> = [
      ["個人 owner", owner!.id, personal.id, { role: "owner", ownerId: owner!.id, groupId: null, permissions: OWNER_PERMISSIONS }],
      ["逐人 editor", ed!.id, personal.id, { role: "editor", ownerId: owner!.id, groupId: null, permissions: P({ read: true, edit: true }) }],
      ["逐人 viewer", vw!.id, personal.id, { role: "viewer", ownerId: owner!.id, groupId: null, permissions: P({ read: true }) }],
      ["陌生人", stranger!.id, personal.id, NONE],
      ["群組成員查別人的個人筆記（成員資格不外溢）", member!.id, personal.id, NONE],
      ["內建管理員", admin!.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true, delete: true, managePublicLink: true, changeSlug: true }) }],
      ["內建一般成員", member!.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true }) }],
      ["只讀自訂", reader!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true }) }],
      ["刪除限定自訂", deleter!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true, delete: true }) }],
      ["公開連結限定自訂", publisher!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true, managePublicLink: true, changeSlug: true }) }],
      ["無閱讀自訂", blind!.id, groupNote.id, NONE],
      ["非成員", stranger!.id, groupNote.id, NONE],
      ["非成員站台 admin", siteAdmin.id, groupNote.id, NONE],
      // A site admin identity adds no note flags - as a regular member they get the regular member role (no delete)
      ["身為一般成員的站台 admin", memberSiteAdmin.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true }) }],
      ["不存在", owner!.id, "00000000-0000-4000-8000-00000000dead", NONE],
      ["非 UUID", owner!.id, "not-a-uuid", NONE],
    ];
    // expect.soft: each row reports red on its own, not aborting at the first failure
    for (const [label, userId, noteId, expected] of cases) {
      expect.soft(await resolveNoteAccess(db, userId, noteId), label).toEqual(expected);
      expect.soft(await resolveRole(db, userId, noteId), label).toBe(expected.role);
    }
  });

  it("residual per-person share rows on group notes (a group note shouldn't have share rows, inserted directly into the DB) grant a non-member nothing; when a member also has a share row the group role prevails", async () => {
    const { db } = await buildTestApp();
    const [admin, reader, outsider] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: reader.id, role: "member" }]);
    await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    const note = await seedNote(db, { groupId: g.id });
    await seedShare(db, note.id, outsider.id, "editor");
    await seedShare(db, note.id, reader.id, "editor");
    expect(await resolveNoteAccess(db, outsider.id, note.id)).toEqual(NONE);
    expect(await resolveNoteAccess(db, reader.id, note.id)).toEqual({ role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true }) });
  });

  it("roleFromGroupFlags: edit -> editor, read only -> viewer, neither -> none", () => {
    expect(roleFromGroupFlags({ canRead: true, canEdit: true })).toBe("editor");
    expect(roleFromGroupFlags({ canRead: true, canEdit: false })).toBe("viewer");
    expect(roleFromGroupFlags({ canRead: false, canEdit: false })).toBe("none");
  });

  it("single SELECT: notes PK, the two member/share indexes, group_roles PK; no Seq Scan", async () => {
    const { db } = await buildTestApp();
    const { userId, noteId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, accessQuery(db, userId, noteId).toSQL());
    expect(plan).toContain("notes_pkey");
    expect(plan).toMatch(/group_members_group_id_user_id_pk|group_members_user_idx/);
    expect(plan).toMatch(/note_shares_note_id_user_id_pk|note_shares_user_idx/);
    expect(plan).toContain("group_roles_pkey");
    expect(plan).not.toContain("Seq Scan");
  });
});
