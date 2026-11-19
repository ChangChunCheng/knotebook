import { describe, expect, it } from "vitest";
import type { GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, setMemberRole, spyCollabHooks, type SeededUser,
} from "./group-helpers.js";

const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
const ALL: GroupRoleFlags = { create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true };
const ADMIN_PERMISSIONS = { read: true, ...ALL };
/** Default flags of the built-in plain member (`seedGroup`, migration 0012: create + edit). */
const MEMBER_FLAGS: GroupRoleFlags = { ...NONE, create: true, edit: true };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

async function setup() {
  const spy = spyCollabHooks();
  const { app, db } = await buildTestApp({ collabHooks: spy });
  const a = await seedUser(db);
  const b = await seedUser(db);
  const c = await seedUser(db);
  const g = await seedGroup(db, "Roles", [
    { userId: a.id, role: "admin" },
    { userId: b.id, role: "member" },
    { userId: c.id, role: "member" },
  ]);
  const n1 = await seedNote(db, { groupId: g.id });
  const n2 = await seedNote(db, { groupId: g.id });
  await seedNote(db, { ownerId: a.id });
  const groupNotes = sorted([n1.id, n2.id]);
  const adminCookies = await cookieOf(a.id);
  const createRole = async (name: string, permissions: GroupRoleFlags): Promise<GroupRoleDto> => {
    const res = await app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies: adminCookies, payload: { name, permissions } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as GroupRoleDto;
  };
  const patch = async (roleId: string, payload: unknown, cookies = adminCookies) =>
    app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${roleId}`, cookies, payload: payload as Record<string, unknown> });
  const del = async (roleId: string, cookies = adminCookies) =>
    app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${roleId}`, cookies });
  const roles = async (): Promise<GroupRoleDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupRoleDto[];
  };
  const members = async (): Promise<GroupMemberDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupMemberDto[];
  };
  const memberOf = async (u: SeededUser): Promise<GroupMemberDto | undefined> => (await members()).find(m => m.userId === u.id);
  const kickCall = (nth: number): { noteIds: string[]; userIds: string[] } => {
    const call = spy.onGroupAccessChanged.mock.calls[nth - 1];
    expect(call, `第 ${nth} 次 onGroupAccessChanged`).toBeDefined();
    return { noteIds: sorted(call![0]), userIds: sorted(call![1]) };
  };
  return { app, db, spy, a, b, c, g, groupNotes, adminCookies, createRole, patch, del, roles, members, memberOf, kickCall };
}

describe("#175 PATCH/DELETE .../roles/:roleId: authorization", () => {
  it("PATCH authorization matrix: 401 / 404 x3 (byte-identical) / 403 / 200 / site admin 200", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: (g, s) => `/api/groups/${g}/roles/${s.customRoleId}`,
      payload: () => ({ name: "Renamed" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("DELETE authorization matrix: 401 / 404 x3 (byte-identical) / 403 / 204 / site admin 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: (g, s) => `/api/groups/${g}/roles/${s.customRoleId}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("authorization checks the caller's manageGroup (not manageMembers): only manageMembers -> PATCH/DELETE both 403 with nothing written; only manageGroup -> 200/204; 403 comes before the :roleId and body checks", async () => {
    const { db, g, b, patch, del, roles, createRole } = await setup();
    const target = await createRole("Target", NONE);
    const doorman = await seedRole(db, g.id, "Doorman", { canRead: true, canManageMembers: true });
    const renamer = await seedRole(db, g.id, "Renamer", { canRead: true, canManageGroup: true });
    const cookies = await cookieOf(b.id);
    await setMemberRole(db, g.id, b.id, doorman);
    for (const res of [
      await patch(target.id, { name: "ByDoorman" }, cookies),
      await del(target.id, cookies),
      await patch("not-a-uuid", {}, cookies),
      await del("not-a-uuid", cookies),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer", "Target"]);
    await setMemberRole(db, g.id, b.id, renamer);
    const renamed = await patch(target.id, { name: "ByRenamer" }, cookies);
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe("ByRenamer");
    expect((await del(target.id, cookies)).statusCode).toBe(204);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer"]);
  });

  it("site admin who is a built-in plain member -> PATCH 200, DELETE 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "SA", [{ userId: owner.id, role: "admin" }, { userId: siteAdmin.id, role: "member" }]);
    const roleId = await seedRole(db, g.id, "Custom", { canRead: true });
    const cookies = await cookieOf(siteAdmin.id);
    const patched = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${roleId}`, cookies, payload: { name: "ByAdmin" } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ id: roleId, builtin: null, name: "ByAdmin" });
    const deleted = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${roleId}`, cookies });
    expect(deleted.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies });
    expect((list.json() as GroupRoleDto[]).map(r => r.builtin)).toEqual(["admin", "member"]);
  });
});

describe("#175 PATCH .../roles/:roleId (edit role)", () => {
  it("edit custom role: rename + flags together -> 200 with new values in the body; changing to create-only -> 200; GET read-back matches; memberCount = actual number of holders", async () => {
    const { db, g, b, c, patch, roles, createRole } = await setup();
    const role = await createRole("Editors", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, role.id);
    await setMemberRole(db, g.id, c.id, role.id);
    const res = await patch(role.id, { name: "  Curators ", permissions: { ...NONE, edit: true, delete: true, managePublicLink: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id: role.id,
      builtin: null,
      name: "Curators",
      permissions: { read: true, create: false, edit: true, delete: true, managePublicLink: true, manageMembers: false, manageGroup: false },
      memberCount: 2,
    });
    expect((await roles()).find(r => r.id === role.id)).toEqual(res.json());

    const createOnly = await patch(role.id, { permissions: { ...NONE, create: true } });
    expect(createOnly.statusCode, createOnly.body).toBe(200);
    const CREATE_ONLY = { read: true, ...NONE, create: true };
    expect(createOnly.json()).toEqual({ id: role.id, builtin: null, name: "Curators", permissions: CREATE_ONLY, memberCount: 2 });
    expect((await roles()).find(r => r.id === role.id)).toEqual(createOnly.json());
  });

  it("self-collision: renaming Reader to READER -> 200 (only collides with itself); renaming Writer to reader -> 409 role_name_taken and the name is unchanged; renaming to a reserved name -> 409", async () => {
    const { patch, roles, createRole } = await setup();
    const reader = await createRole("Reader", NONE);
    const writer = await createRole("Writer", { ...NONE, edit: true });
    const self = await patch(reader.id, { name: "READER" });
    expect(self.statusCode, self.body).toBe(200);
    expect(self.json().name).toBe("READER");
    const TAKEN = { error: { code: "role_name_taken", message: "This group already has a role with that name, or the name is reserved for a built-in role." } };
    const clash = await patch(writer.id, { name: "reader" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual(TAKEN);
    const reserved = await patch(writer.id, { name: "管理員" });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json()).toEqual(TAKEN);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "READER", "Writer"]);
  });

  it("built-in admin: PATCH flags (all on) or name -> 409 builtin_role; read-back unchanged", async () => {
    const { g, patch, roles } = await setup();
    const before = (await roles()).find(r => r.id === g.adminRoleId);
    expect(before).toMatchObject({ builtin: "admin", name: null, permissions: ADMIN_PERMISSIONS });
    for (const payload of [{ permissions: ALL }, { name: "Boss" }, { permissions: NONE }]) {
      const res = await patch(g.adminRoleId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
      expect(res.json()).toEqual({ error: { code: "builtin_role", message: "The built-in Admin role can't be changed." } });
    }
    expect((await roles()).find(r => r.id === g.adminRoleId)).toEqual(before);
  });

  it("built-in plain member: changing flags (removing create) -> 200; rename -> 409 builtin_role; read-back name stays null", async () => {
    const { g, patch, roles } = await setup();
    const res = await patch(g.memberRoleId, { permissions: { ...NONE, edit: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: g.memberRoleId, builtin: "member", name: null, permissions: { read: true, ...NONE, edit: true }, memberCount: 2 });
    for (const payload of [{ name: "Staff" }, { name: "Staff", permissions: MEMBER_FLAGS }]) {
      const renamed = await patch(g.memberRoleId, payload);
      expect(renamed.statusCode, JSON.stringify(payload)).toBe(409);
      expect(renamed.json()).toEqual({ error: { code: "builtin_role", message: "The built-in Member role can't be renamed." } });
    }
    expect((await roles()).find(r => r.id === g.memberRoleId)).toEqual(res.json());
  });

  it("error shapes: non-UUID :roleId / role of another group -> 404 role_not_found; {}, with read, extra keys, missing flag -> 400 invalid_body; empty name -> 400 invalid_name; nothing written in any case", async () => {
    const { app, db, a, patch, roles, createRole } = await setup();
    const role = await createRole("Keep", NONE);
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    for (const roleId of ["not-a-uuid", otherRole, other.memberRoleId]) {
      const res = await patch(roleId, { name: "X" });
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "No role with that id." } });
    }
    // Ordering: a non-UUID 404 comes before the body 400.
    const badBoth = await patch("not-a-uuid", {});
    expect(badBoth.statusCode).toBe(404);
    expect(badBoth.json().error.code).toBe("role_not_found");
    const { manageGroup: _omit, ...missingOne } = NONE;
    for (const payload of [{},{ permissions: { ...NONE, read: true } }, { name: "X", builtin: null }, { permissions: missingOne }, { name: 5 }]) {
      const res = await patch(role.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    const empty = await patch(role.id, { name: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: { code: "invalid_name", message: "Role names must be 1 to 40 characters." } });
    expect((await roles()).find(r => r.id === role.id)).toEqual(role);
    const elsewhere = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((elsewhere.json() as GroupRoleDto[]).find(r => r.id === otherRole)?.name).toBe("Elsewhere");
  });

  it("error order: the reserved-name check comes before the role lookup - renaming the built-in plain member to Admin, the built-in admin to Member, or another group's role / a missing UUID to a reserved name -> all 409 role_name_taken; nothing written", async () => {
    const { app, db, a, g, patch, roles } = await setup();
    const before = await roles();
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    const TAKEN = { error: { code: "role_name_taken", message: "This group already has a role with that name, or the name is reserved for a built-in role." } };
    for (const [roleId, name] of [
      [g.memberRoleId, "Admin"],
      [g.adminRoleId, "Member"],
      [otherRole, "admin"],
      ["00000000-0000-4000-8000-000000000000", "一般成員"],
    ] as const) {
      const res = await patch(roleId, { name });
      expect(res.statusCode, `${roleId} ${name}`).toBe(409);
      expect(res.json()).toEqual(TAKEN);
    }
    expect(await roles()).toEqual(before);
    const elsewhere = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((elsewhere.json() as GroupRoleDto[]).find(r => r.id === otherRole)?.name).toBe("Elsewhere");
  });

  it("revocation: changing only delete/managePublicLink/manageMembers/manageGroup, only the name, or sending the same values -> 0 calls; edit off/on -> exactly 1 call each (group's two notes, [B, C]); changing edit on a role nobody holds -> 0 calls", async () => {
    const { db, g, b, c, spy, groupNotes, patch, createRole, kickCall } = await setup();
    const writers = await createRole("Writers", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, writers.id);
    await setMemberRole(db, g.id, c.id, writers.id);
    for (const flag of ["delete", "managePublicLink", "manageMembers", "manageGroup"] as const) {
      const res = await patch(writers.id, { permissions: { ...NONE, edit: true, [flag]: true } });
      expect(res.statusCode, flag).toBe(200);
      expect(res.json().permissions[flag]).toBe(true);
    }
    expect((await patch(writers.id, { name: "Scribes" })).statusCode).toBe(200);
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(0);

    const off = await patch(writers.id, { permissions: NONE });
    expect(off.statusCode).toBe(200);
    expect(off.json().permissions).toEqual({ read: true, ...NONE });
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(kickCall(1)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expect(kickCall(2)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });

    const unheld = await createRole("Nobody", { ...NONE, edit: true });
    expect((await patch(unheld.id, { permissions: NONE })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(2);
  });

  it("turning off edit and create on the built-in plain member -> 200, read stays true, revocation (group's two notes, [B, C]) exactly once, built-in admin A not in the list", async () => {
    const { g, a, b, c, spy, groupNotes, patch, roles, kickCall } = await setup();
    const res = await patch(g.memberRoleId, { permissions: NONE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().permissions).toEqual({ read: true, ...NONE });
    expect((await roles()).find(r => r.id === g.memberRoleId)?.permissions.read).toBe(true);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const kick = kickCall(1);
    expect(kick).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });
    expect(kick.userIds).not.toContain(a.id);
  });
});

describe("#175 DELETE .../roles/:roleId (delete role)", () => {
  it("delete custom role: holders B and C move to the built-in plain member, the role is gone, revocation (group's two notes, [B, C]) exactly once; deleting one nobody holds -> 204 with no revocation; the same name can be created again", async () => {
    const { db, g, b, c, spy, groupNotes, del, roles, memberOf, createRole, kickCall, app, adminCookies } = await setup();
    const readers = await createRole("Readers", NONE);
    await setMemberRole(db, g.id, b.id, readers.id);
    await setMemberRole(db, g.id, c.id, readers.id);
    expect((await memberOf(b))?.roleId).toBe(readers.id);
    const res = await del(readers.id);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    for (const u of [b, c]) expect(await memberOf(u)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect((await roles()).map(r => r.id)).not.toContain(readers.id);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(kickCall(1)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });

    const lonely = await createRole("Lonely", { ...NONE, edit: true });
    expect((await del(lonely.id)).statusCode).toBe(204);
    expect((await roles()).map(r => r.id)).not.toContain(lonely.id);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);

    const again = await app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies: adminCookies, payload: { name: "Readers", permissions: NONE } });
    expect(again.statusCode, again.body).toBe(201);
  });

  it("deleting a built-in role (admin / plain member) -> 409 builtin_role; the four role rows are unchanged", async () => {
    const { g, del, roles, createRole } = await setup();
    await createRole("One", NONE);
    await createRole("Two", NONE);
    const before = await roles();
    expect(before).toHaveLength(4);
    for (const roleId of [g.adminRoleId, g.memberRoleId]) {
      const res = await del(roleId);
      expect(res.statusCode, roleId).toBe(409);
      expect(res.json()).toEqual({ error: { code: "builtin_role", message: "Built-in roles can't be deleted." } });
    }
    expect(await roles()).toEqual(before);
  });

  it("error shapes: non-UUID :roleId / role of another group -> 404 role_not_found, the other group's role is not deleted", async () => {
    const { app, db, a, del } = await setup();
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    for (const roleId of ["not-a-uuid", otherRole]) {
      const res = await del(roleId);
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "No role with that id." } });
    }
    const list = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((list.json() as GroupRoleDto[]).map(r => r.id)).toContain(otherRole);
  });

  it("unaffected: after deleting a custom role and changing the built-in plain member's flags, the only built-in admin A is still the built-in admin", async () => {
    const { db, g, a, b, del, patch, memberOf, createRole } = await setup();
    const custom = await createRole("Temp", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, custom.id);
    expect((await del(custom.id)).statusCode).toBe(204);
    expect((await patch(g.memberRoleId, { permissions: NONE })).statusCode).toBe(200);
    expect(await memberOf(a)).toMatchObject({ roleId: g.adminRoleId, builtin: "admin" });
    expect(await memberOf(b)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
  });
});
