import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { GroupDto, GroupMemberDto, GroupRoleDto } from "@knotebook/shared";
import { groupMembers, groupRoles, groups } from "../src/db/schema.js";
import { groupNoteIdsQuery, listMyGroupsQuery } from "../src/groups/queries.js";
import { buildTestApp } from "./helpers.js";
import {
  PLANNER_GROUP_OF_USER1, cookieOf, planOf, runGroupAuthMatrix, seedGroup, seedPlannerData, seedRole, seedUser, setMemberRole,
  spyCollabHooks,
} from "./group-helpers.js";

const NUL = String.fromCharCode(0);

const ADMIN_PERMISSIONS = {
  read: true, create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true,
} as const;
const MEMBER_PERMISSIONS = {
  read: true, create: true, edit: true, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false,
} as const;

describe("#103/#175 POST/GET /api/groups", () => {
  it("POST: 201 GroupDto (myRole = built-in admin object, both canManage* true, name trimmed); both built-in roles created in the same transaction, creator holds admin; created_by = me; not signed in 401", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const res = await app.inject({ method: "POST", url: "/api/groups", cookies: await cookieOf(me.id), payload: { name: "  Design  " } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as GroupDto;
    expect(Object.keys(body).sort()).toEqual(["autoVersions", "canManageGroup", "canManageMembers", "createdAt", "id", "myRole", "name"]);
    expect(body).toMatchObject({ name: "Design", canManageMembers: true, canManageGroup: true });
    expect(body.myRole).toEqual({ id: expect.any(String), builtin: "admin", name: null, memberCount: 1, permissions: ADMIN_PERMISSIONS });

    const roles = await db
      .select({
        id: groupRoles.id, builtin: groupRoles.builtin, name: groupRoles.name,
        canRead: groupRoles.canRead, canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit, canDelete: groupRoles.canDelete,
        canManagePublicLink: groupRoles.canManagePublicLink, canManageMembers: groupRoles.canManageMembers, canManageGroup: groupRoles.canManageGroup,
      })
      .from(groupRoles)
      .where(eq(groupRoles.groupId, body.id))
      .orderBy(asc(groupRoles.builtin));
    expect(roles.map(({ id: _id, ...rest }) => rest)).toEqual([
      { builtin: "admin", name: null, canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true },
      { builtin: "member", name: null, canRead: true, canCreate: true, canEdit: true, canDelete: false, canManagePublicLink: false, canManageMembers: false, canManageGroup: false },
    ]);
    const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, body.id));
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: me.id, roleId: roles[0]!.id });
    expect(body.myRole!.id).toBe(roles[0]!.id);
    const [g] = await db.select().from(groups).where(eq(groups.id, body.id));
    expect(g!.createdBy).toBe(me.id);
    expect((await app.inject({ method: "POST", url: "/api/groups", payload: { name: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/groups" })).statusCode).toBe(401);
  });

  it("name boundaries - NUL / lone surrogate / all whitespace / 81 characters -> 400 invalid_name (not 500); 80 emoji accepted; wrong type / extra fields -> 400 invalid_body", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const cookies = await cookieOf(me.id);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/groups", cookies, payload: payload as Record<string, unknown> });
    for (const name of [`a${NUL}b`, "\uD800", "   ", "", "x".repeat(81), "\u{1F600}".repeat(81)]) {
      const res = await post({ name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json().error.code).toBe("invalid_name");
    }
    const emoji = await post({ name: "\u{1F600}".repeat(80) });
    expect(emoji.statusCode).toBe(201);
    expect(emoji.json().name).toBe("\u{1F600}".repeat(80));
    for (const payload of [{}, { name: 5 }, { name: "ok", extra: 1 }]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
  });

  it("GET /api/groups: lists only those I belong to, ordered by my role (built-in admin -> regular member) then name, id; myRole object shape (memberCount = number of people holding that role); a site admin's canManage* is always true and sees no groups they don't belong to", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db, { isAdmin: true });
    const other = await seedUser(db);
    const plain = await seedUser(db);
    const same1 = await seedGroup(db, "Same", [{ userId: me.id, role: "member" }, { userId: other.id, role: "admin" }, { userId: plain.id, role: "member" }]);
    const same2 = await seedGroup(db, "Same", [{ userId: me.id, role: "admin" }]);
    const alpha = await seedGroup(db, "Alpha", [{ userId: me.id, role: "admin" }]);
    await seedGroup(db, "Aardvark", [{ userId: other.id, role: "admin" }]);

    const res = await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(me.id) });
    expect(res.statusCode).toBe(200);
    const list = res.json() as GroupDto[];
    // I'm admin in Alpha and same2 and a regular member in same1: the two admin ones come first (by name), the regular member one after.
    expect(list.map(g => g.id)).toEqual([alpha.id, same2.id, same1.id]);
    const s1 = list.find(g => g.id === same1.id)!;
    expect(s1.myRole).toEqual({ id: same1.memberRoleId, builtin: "member", name: null, memberCount: 2, permissions: MEMBER_PERMISSIONS });
    // Site admin: the role is regular member, both canManage* are still true.
    expect(s1).toMatchObject({ canManageMembers: true, canManageGroup: true });
    expect(list.find(g => g.id === same2.id)!.myRole).toMatchObject({ id: same2.adminRoleId, builtin: "admin", memberCount: 1 });

    // Regular user: regular member role -> both canManage* false.
    const plainList = (await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(plain.id) })).json() as GroupDto[];
    expect(plainList).toHaveLength(1);
    expect(plainList[0]).toMatchObject({ id: same1.id, canManageMembers: false, canManageGroup: false });
    expect(plainList[0]!.myRole!.permissions.manageGroup).toBe(false);
  });

  it("GET /api/groups ordering: groups with built-in admin first, then built-in regular member, then custom roles; within a class by name then id (the regular member Delta sorts alphabetically after the custom-role Beta/Gamma; two groups both named Beta are ordered by id; the order of the sidebar groups tab)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const other = await seedUser(db);
    // Deliberately make creation order the reverse of id order: beta is created with the larger id first, beta2 with the smaller id after (fixed ids, no random retry);
    // without asc(groups.id) the result would follow creation (heap) order, beta then beta2, and the assertion necessarily goes red.
    // The lexicographic order of lowercase uuid strings matches Postgres uuid order (16 bytes compared from the most significant).
    const [lo, hi] = [randomUUID(), randomUUID()].sort();
    const beta = await seedGroup(db, "Beta", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }], { id: hi });
    await setMemberRole(db, beta.id, me.id, await seedRole(db, beta.id, "Reader", { canRead: true }));
    const beta2 = await seedGroup(db, "Beta", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }], { id: lo });
    await setMemberRole(db, beta2.id, me.id, await seedRole(db, beta2.id, "Reader", { canRead: true }));
    const delta = await seedGroup(db, "Delta", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }]);
    const zeta = await seedGroup(db, "Zeta", [{ userId: me.id, role: "admin" }]);
    const gamma = await seedGroup(db, "Gamma", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }]);
    await setMemberRole(db, gamma.id, me.id, await seedRole(db, gamma.id, "Editor", { canRead: true, canEdit: true }));
    await seedGroup(db, "Aardvark", [{ userId: other.id, role: "admin" }]);

    const res = await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(me.id) });
    expect(res.statusCode).toBe(200);
    const list = res.json() as GroupDto[];
    expect(list.map(g => g.name)).toEqual(["Zeta", "Delta", "Beta", "Beta", "Gamma"]);
    expect(list.map(g => g.id)).toEqual([zeta.id, delta.id, beta2.id, beta.id, gamma.id]);
    expect(list.map(g => g.myRole?.builtin ?? null)).toEqual(["admin", "member", null, null, null]);
  });
});

describe("#103/#175 PATCH /api/groups/:id and GET .../members", () => {
  it("PATCH rename authorization matrix (including site admin, non-UUID, nonexistent; the three 404s byte-for-byte identical)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: id => `/api/groups/${id}`,
      payload: () => ({ name: "Renamed" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("PATCH: written after trim, returns GroupDto; a regular member gets 403 first even with a bad body (new message); admin sending a bad name -> 400 invalid_name, {} -> 400 invalid_body; a non-member site admin's response has myRole=null and both canManage* true", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "Old", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const ok = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " New " } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: g.id, name: "New", canManageMembers: true, canManageGroup: true, myRole: { id: g.adminRoleId, builtin: "admin" } });
    const forbidden = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(member.id), payload: {} });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: { code: "forbidden", message: "Your role in this group can't do this." } });
    const bad = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_name");
    const emptyBody = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: {} });
    expect(emptyBody.statusCode).toBe(400);
    expect(emptyBody.json().error.code).toBe("invalid_body");
    const bySite = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(site.id), payload: { name: "Site" } });
    expect(bySite.statusCode).toBe(200);
    expect(bySite.json()).toMatchObject({ name: "Site", myRole: null, canManageMembers: true, canManageGroup: true });
  });

  it("a site admin who is a regular member can rename and add people (role flag OR site admin, not only membership)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const newcomer = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: site.id, role: "member" }]);
    const cookies = await cookieOf(site.id);
    const rename = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies, payload: { name: "BySite" } });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: "BySite", myRole: { builtin: "member" }, canManageMembers: true, canManageGroup: true });
    const add = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: newcomer.email } });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ userId: newcomer.id, builtin: "member", roleId: g.memberRoleId });
  });

  it("GET .../members authorization matrix (members can read)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "GET",
      url: id => `/api/groups/${id}/members`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("GET .../members: built-in admins first, then displayName, then userId; each row { userId, email, displayName, roleId, builtin }", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const zed = await seedUser(db, { displayName: "Zed" });
    const amy1 = await seedUser(db, { displayName: "Amy" });
    const amy2 = await seedUser(db, { displayName: "Amy" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "G", [
      { userId: bob.id, role: "member" },
      { userId: zed.id, role: "admin" },
      { userId: amy2.id, role: "member" },
      { userId: amy1.id, role: "member" },
    ]);
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(bob.id) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as GroupMemberDto[];
    const amys = [amy1.id, amy2.id].sort();
    expect(rows.map(r => r.userId)).toEqual([zed.id, ...amys, bob.id]);
    expect(rows[0]).toEqual({ userId: zed.id, email: zed.email, displayName: "Zed", roleId: g.adminRoleId, builtin: "admin", avatar: null });
    expect(rows[1]).toEqual({ userId: amys[0], email: expect.any(String), displayName: "Amy", roleId: g.memberRoleId, builtin: "member", avatar: null });
    expect(Object.keys(rows[3]!).sort()).toEqual(["avatar", "builtin", "displayName", "email", "roleId", "userId"]);
  });

  it("indexes: GET /api/groups uses group_members_user_idx; 'all notes in the group' uses notes_group_slug_idx", async () => {
    const { db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const { userId } = await seedPlannerData(db.$client);
    expect(await planOf(db.$client, listMyGroupsQuery(db, userId).toSQL())).toContain("group_members_user_idx");
    expect(await planOf(db.$client, groupNoteIdsQuery(db, PLANNER_GROUP_OF_USER1).toSQL())).toContain("notes_group_slug_idx");
  });
});

describe("#175 GET /api/groups/:id/roles (read-only)", () => {
  it("authorization matrix: members can read, a non-member site admin can too; non-member/non-UUID/nonexistent 404 byte-for-byte identical", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "GET",
      url: id => `/api/groups/${id}/roles`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("order: built-in admin, built-in regular member, the rest by name (case-insensitive); memberCount correct; GroupRoleDto shape", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const m1 = await seedUser(db);
    const m2 = await seedUser(db);
    const reader = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "G", [
      { userId: admin.id, role: "admin" }, { userId: m1.id, role: "member" }, { userId: m2.id, role: "member" }, { userId: reader.id, role: "member" },
    ]);
    const beta = await seedRole(db, g.id, "beta", { canRead: true });
    const alpha = await seedRole(db, g.id, "Alpha", { canRead: true, canManageMembers: true });
    await setMemberRole(db, g.id, reader.id, beta);

    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(m1.id) });
    expect(res.statusCode).toBe(200);
    const roles = res.json() as GroupRoleDto[];
    expect(roles.map(r => r.id)).toEqual([g.adminRoleId, g.memberRoleId, alpha, beta]);
    expect(roles.map(r => [r.builtin, r.name, r.memberCount])).toEqual([["admin", null, 1], ["member", null, 2], [null, "Alpha", 0], [null, "beta", 1]]);
    expect(roles[0]).toEqual({ id: g.adminRoleId, builtin: "admin", name: null, memberCount: 1, permissions: ADMIN_PERMISSIONS });
    expect(roles[2]!.permissions).toEqual({
      read: true, create: false, edit: false, delete: false, managePublicLink: false, manageMembers: true, manageGroup: false,
    });

    const bySite = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(site.id) });
    expect(bySite.statusCode).toBe(200);
    expect(bySite.json()).toEqual(roles);
  });
});
