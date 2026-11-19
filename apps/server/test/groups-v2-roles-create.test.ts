import { describe, expect, it } from "vitest";
import type { GroupRoleDto } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import { cookieOf, runGroupAuthMatrix, seedGroup, seedRole, seedUser, setMemberRole, spyCollabHooks } from "./group-helpers.js";

const NUL = String.fromCharCode(0);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NONE = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false } as const;

async function setup() {
  const spy = spyCollabHooks();
  const { app, db } = await buildTestApp({ collabHooks: spy });
  const admin = await seedUser(db);
  const member = await seedUser(db);
  const g = await seedGroup(db, "Roles", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
  ]);
  const adminCookies = await cookieOf(admin.id);
  const post = async (payload: unknown, cookies = adminCookies) =>
    app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies, payload: payload as Record<string, unknown> });
  const roles = async (): Promise<GroupRoleDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupRoleDto[];
  };
  return { app, db, spy, admin, member, g, post, roles };
}

describe("#175 POST /api/groups/:id/roles", () => {
  it("authorization matrix: 401 / 404 x3 (byte-identical) / 403 / 201 / site admin 201", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "POST",
      url: g => `/api/groups/${g}/roles`,
      payload: () => ({ name: "Reader", permissions: NONE }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 201, siteAdmin: 201, badId: 404, missing: 404 },
    });
  });

  it("201 shape: name normalized, permissions has seven keys with read always true, memberCount 0; the GET read-back lists custom roles after the two built-ins, ordered by lower(name)", async () => {
    const { post, roles } = await setup();
    const res = await post({ name: "  Reviewers ", permissions: { ...NONE, edit: true } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as GroupRoleDto;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_SHAPE),
      builtin: null,
      name: "Reviewers",
      permissions: { read: true, create: false, edit: true, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false },
      memberCount: 0,
    });
    const list = await roles();
    expect(list.map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Reviewers"]);
    expect(list[2]).toEqual(body);
    expect((await post({ name: "alpha", permissions: NONE })).statusCode).toBe(201);
    expect((await post({ name: "Beta", permissions: NONE })).statusCode).toBe(201);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "alpha", "Beta", "Reviewers"]);
  });

  it("all six flags off -> 201, stored as read-only (read true, the rest false)", async () => {
    const { post, roles } = await setup();
    const res = await post({ name: "Readers", permissions: NONE });
    expect(res.statusCode).toBe(201);
    const READ_ONLY = { read: true, create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
    expect(res.json().permissions).toEqual(READ_ONLY);
    const row = (await roles()).find(r => r.id === res.json().id);
    expect(row?.permissions).toEqual(READ_ONLY);
  });

  it("body with a read key (true and false) -> 400 invalid_body and nothing written to the DB; create-only (can create, cannot edit) -> 201", async () => {
    const { post, roles } = await setup();
    for (const read of [true, false]) {
      const res = await post({ name: "WithRead", permissions: { ...NONE, read } });
      expect(res.statusCode, `read=${read}`).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await roles()).toHaveLength(2);
    const res = await post({ name: "Creators", permissions: { ...NONE, create: true } });
    expect(res.statusCode).toBe(201);
    const CREATE_ONLY = { read: true, create: true, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
    expect(res.json().permissions).toEqual(CREATE_ONLY);
    expect((await roles()).find(r => r.id === res.json().id)?.permissions).toEqual(CREATE_ONLY);
  });

  it("the two management flags are independent: only manageGroup -> 201; only manageMembers -> 201", async () => {
    const { post, roles } = await setup();
    const g1 = await post({ name: "GroupOnly", permissions: { ...NONE, manageGroup: true } });
    expect(g1.statusCode).toBe(201);
    expect(g1.json().permissions).toMatchObject({ manageGroup: true, manageMembers: false });
    const m1 = await post({ name: "MembersOnly", permissions: { ...NONE, manageMembers: true } });
    expect(m1.statusCode).toBe(201);
    expect(m1.json().permissions).toMatchObject({ manageGroup: false, manageMembers: true });
    const list = await roles();
    expect(list.find(r => r.id === g1.json().id)?.permissions).toMatchObject({ manageGroup: true, manageMembers: false });
    expect(list.find(r => r.id === m1.json().id)?.permissions).toMatchObject({ manageGroup: false, manageMembers: true });
  });

  it("name: trim / case / NFC collisions and reserved names -> 409 role_name_taken; 'Admins' is allowed", async () => {
    const { post, roles } = await setup();
    const reader = await post({ name: " Reader ", permissions: NONE });
    expect(reader.statusCode).toBe(201);
    expect(reader.json().name).toBe("Reader");
    const cafe = await post({ name: "Café", permissions: NONE });
    expect(cafe.statusCode).toBe(201);
    expect(cafe.json().name).toBe("Café");
    for (const name of ["reader", "Café", "admin", "MEMBER", "管理員", "一般成員"]) {
      const res = await post({ name, permissions: NONE });
      expect(res.statusCode, name).toBe(409);
      expect(res.json()).toEqual({ error: { code: "role_name_taken", message: "This group already has a role with that name, or the name is reserved for a built-in role." } });
    }
    expect((await post({ name: "Admins", permissions: NONE })).statusCode).toBe(201);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Admins", "Café", "Reader"]);
  });

  it("name boundaries: empty / whitespace only / 41 chars / NUL / lone surrogate -> 400 invalid_name (not 500); 40 emoji -> 201", async () => {
    const { post, roles } = await setup();
    for (const name of ["", "   ", "a".repeat(41), `a${NUL}b`, "\uD800"]) {
      const res = await post({ name, permissions: NONE });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json()).toEqual({ error: { code: "invalid_name", message: "Role names must be 1 to 40 characters." } });
    }
    expect(await roles()).toHaveLength(2);
    const emoji = await post({ name: "\u{1F600}".repeat(40), permissions: NONE });
    expect(emoji.statusCode).toBe(201);
    expect(emoji.json().name).toBe("\u{1F600}".repeat(40));
  });

  it("body shape: one flag missing / extra builtin key / non-string name -> 400 invalid_body", async () => {
    const { post, roles } = await setup();
    const { manageGroup: _omit, ...missingOne } = NONE;
    for (const payload of [
      { name: "X", permissions: missingOne },
      { name: "X", builtin: null, permissions: NONE },
      { name: 5, permissions: NONE },
    ]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await roles()).toHaveLength(2);
  });

  it("authorization checks the caller's manageGroup (not manageMembers): a custom-role member with only manageMembers -> 403 and nothing written; with only manageGroup -> 201", async () => {
    const { db, g, member, post, roles } = await setup();
    const doorman = await seedRole(db, g.id, "Doorman", { canRead: true, canManageMembers: true });
    const renamer = await seedRole(db, g.id, "Renamer", { canRead: true, canManageGroup: true });
    const cookies = await cookieOf(member.id);
    await setMemberRole(db, g.id, member.id, doorman);
    const denied = await post({ name: "ByDoorman", permissions: NONE }, cookies);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer"]);
    await setMemberRole(db, g.id, member.id, renamer);
    const ok = await post({ name: "ByRenamer", permissions: NONE }, cookies);
    expect(ok.statusCode).toBe(201);
  });

  it("authorization comes before the body: a plain member sending a bad body ({}) gets 403, not 400", async () => {
    const { post, member } = await setup();
    const res = await post({}, await cookieOf(member.id));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("site admin who is a built-in plain member -> 201", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "SA", [{ userId: owner.id, role: "admin" }, { userId: siteAdmin.id, role: "member" }]);
    const res = await app.inject({
      method: "POST", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(siteAdmin.id), payload: { name: "ByAdmin", permissions: NONE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ builtin: null, name: "ByAdmin", memberCount: 0 });
  });

  it("no revocation: creating several roles calls onGroupAccessChanged 0 times (nobody holds a new role)", async () => {
    const { post, spy } = await setup();
    expect((await post({ name: "A", permissions: NONE })).statusCode).toBe(201);
    expect((await post({ name: "B", permissions: { ...NONE, edit: true, create: true } })).statusCode).toBe(201);
    expect((await post({ name: "C", permissions: { create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true } })).statusCode).toBe(201);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(0);
    expect(spy.onShareChanged).toHaveBeenCalledTimes(0);
    expect(spy.onUserRevoked).toHaveBeenCalledTimes(0);
  });

  it("create-only holder creates a group note: 201, role viewer (canEdit is checked before canRead), GET also viewer; holding an all-off role -> 403", async () => {
    const { app, db, post, member, g } = await setup();
    const createOnly = await post({ name: "Creators", permissions: { ...NONE, create: true } });
    expect(createOnly.statusCode).toBe(201);
    await setMemberRole(db, g.id, member.id, createOnly.json().id);
    const cookies = await cookieOf(member.id);
    const created = await app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id, title: "Draft" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: "viewer", groupId: g.id, ownerId: null });
    expect(created.json().permissions).toMatchObject({ read: true, edit: false });
    const read = await app.inject({ method: "GET", url: `/api/notes/${created.json().id}`, cookies });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ role: "viewer" });
    expect(read.json().permissions).toMatchObject({ read: true, edit: false });

    const none = await post({ name: "Nothing", permissions: NONE });
    expect(none.statusCode).toBe(201);
    await setMemberRole(db, g.id, member.id, none.json().id);
    const denied = await app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id, title: "Nope" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
  });
});
