import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { groupMembers, groupRoles } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import {
  MATRIX_ACTORS, cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, setMemberRole, spyCollabHooks,
  waitForBlockedOrSettled, type MatrixActor,
} from "./group-helpers.js";

/** `builtin` of the member's current role (null for a custom role; undefined if not a member). */
async function roleOf(db: Db, groupId: string, userId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  return row?.builtin;
}

/** Number of built-in admins (what the last-admin rule counts - a custom role with all seven flags doesn't count). */
async function adminCount(db: Db, groupId: string): Promise<number> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupRoles.builtin, "admin")));
  return rows.length;
}

describe("#103/#175 member changes: authorization matrix", () => {
  it("PUT .../members", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PUT",
      url: id => `/api/groups/${id}/members`,
      payload: s => ({ email: s.newcomer.email }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("PATCH .../members/:userId", async () => {
    // The payload of `runGroupAuthMatrix` is a synchronous function and can't get the role id of the scenario's group (`{roleId}` must be that group's role);
    // this test runs the same matrix itself: a fresh scenario per actor, the three 404s byte-for-byte identical.
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const expected: Record<MatrixActor, number> = { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 };
    const notFoundBodies: string[] = [];
    for (const actor of MATRIX_ACTORS) {
      const [admin, member, other, outsider] = [await seedUser(db), await seedUser(db), await seedUser(db), await seedUser(db)];
      const siteAdmin = await seedUser(db, { isAdmin: true });
      const g = await seedGroup(db, "Matrix", [
        { userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: other.id, role: "member" },
      ]);
      const groupId = actor === "badId" ? "not-a-uuid" : actor === "missing" ? randomUUID() : g.id;
      const who = actor === "anon" ? null : actor === "nonMember" ? outsider : actor === "member" ? member : actor === "siteAdmin" ? siteAdmin : admin;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}/members/${other.id}`,
        ...(who ? { cookies: await cookieOf(who.id) } : {}),
        payload: { roleId: g.adminRoleId },
      });
      expect(res.statusCode, `PATCH as ${actor}：${res.body}`).toBe(expected[actor]);
      if (actor === "nonMember" || actor === "badId" || actor === "missing") notFoundBodies.push(res.body);
      if (res.statusCode === 200) expect(await roleOf(db, g.id, other.id)).toBe("admin");
    }
    expect(new Set(notFoundBodies).size).toBe(1);
    expect(JSON.parse(notFoundBodies[0]!)).toEqual({ error: { code: "not_found", message: "No group with that id." } });
  });

  it("DELETE .../members/:userId (removing someone else)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: (id, s) => `/api/groups/${id}/members/${s.other.id}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it(":userId non-UUID/not a member -> 404, byte-for-byte identical to the group 404", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    const bodies = [
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies, payload: { roleId: g.adminRoleId } })),
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies, payload: { roleId: g.adminRoleId } })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies })),
    ];
    for (const res of bodies) expect(res.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual({ error: { code: "not_found", message: "No group with that id." } });
  });
});

describe("#103/#175 PUT .../members", () => {
  it("email is case-insensitive, disabled accounts can still be added, defaults to the built-in regular member / roleId can be given; email not found -> 404 user_not_found; invalid roleId / a role of another group -> 404 role_not_found; old key role -> 400", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const plain = await seedUser(db);
    const disabled = await seedUser(db, { disabled: true });
    const third = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const other = await seedGroup(db, "Other", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);

    const a = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: plain.email.toUpperCase() } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ userId: plain.id, email: plain.email, displayName: expect.any(String), roleId: g.memberRoleId, builtin: "member", avatar: null });
    const b = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: disabled.email, roleId: g.adminRoleId } });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ userId: disabled.id, roleId: g.adminRoleId, builtin: "admin" });
    expect(await roleOf(db, g.id, disabled.id)).toBe("admin");
    const missing = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "nobody@example.com" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: "user_not_found", message: "No user with that email." });

    for (const roleId of ["nope", other.memberRoleId]) {
      const res = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: third.email, roleId } });
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "No role with that id." } });
    }
    expect(await roleOf(db, g.id, third.id)).toBeUndefined();
    const legacy = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: third.email, role: "admin" } });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error.code).toBe("invalid_body");
    expect(await roleOf(db, g.id, third.id)).toBeUndefined();
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled(); // adding a member doesn't kick connections
  });

  it("add only: already a member -> 409 already_member, and the existing admin's role is unchanged", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const res = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id), payload: { email: admin.email, roleId: g.memberRoleId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("already_member");
    expect(await roleOf(db, g.id, admin.id)).toBe("admin");
  });

  it("admin sending a bad body -> 400 invalid_body: non-email in PUT .../members; wrong-typed roleId or old key role in PATCH .../members/:userId; non-UUID / other group's roleId in PATCH -> 404 role_not_found", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    const put = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "not-an-email" } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error.code).toBe("invalid_body");
    for (const payload of [{ roleId: 1 }, { role: "admin" }, {}]) {
      const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${member.id}`, cookies, payload });
      expect(patch.statusCode, JSON.stringify(payload)).toBe(400);
      expect(patch.json().error.code).toBe("invalid_body");
    }
    for (const roleId of ["owner", other.adminRoleId]) {
      const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${member.id}`, cookies, payload: { roleId } });
      expect(patch.statusCode, roleId).toBe(404);
      expect(patch.json().error.code).toBe("role_not_found");
    }
    expect(await roleOf(db, g.id, member.id)).toBe("member");
  });
});

describe("#103/#175 every group has at least one built-in admin", () => {
  it("the last built-in admin leaving / being removed by a site admin / being demoted -> 409 last_admin; all allowed with two admins", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const a1 = await seedUser(db);
    const a2 = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }]);
    const leave = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leave.statusCode).toBe(409);
    expect(leave.json().error.code).toBe("last_admin");
    const removedBySite = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(site.id) });
    expect(removedBySite.statusCode).toBe(409);
    expect(removedBySite.json().error.code).toBe("last_admin");
    const demote = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_admin");
    expect(await roleOf(db, g.id, a1.id)).toBe("admin");
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    await db.insert(groupMembers).values({ groupId: g.id, userId: a2.id, roleId: g.adminRoleId });
    const demoteOk = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    expect(demoteOk.statusCode).toBe(200);
    expect(demoteOk.json()).toMatchObject({ userId: a1.id, roleId: g.memberRoleId, builtin: "member" });
    const leaveOk = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leaveOk.statusCode).toBe(204);
  });

  it("only built-in admins count: a custom role with all seven flags doesn't - the only built-in admin demoting / leaving is still 409", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const a1 = await seedUser(db);
    const full = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }, { userId: full.id, role: "member" }]);
    const all = await seedRole(db, g.id, "Everything", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await setMemberRole(db, g.id, full.id, all);
    const demote = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(full.id), payload: { roleId: g.memberRoleId } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_admin");
    const leave = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leave.statusCode).toBe(409);
    expect(await adminCount(db, g.id)).toBe(1);
  });

  it("no guard against privilege escalation: a custom role with only canManageMembers (unreadable) can swap itself into the built-in admin; a custom role with only canManageGroup can create (the two flags are independent)", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const x = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: x.id, role: "member" }]);
    const manager = await seedRole(db, g.id, "Doorman", { canRead: false, canManageMembers: true });
    const groupOnly = await seedRole(db, g.id, "Renamer", { canRead: false, canManageGroup: true });
    expect(groupOnly).toEqual(expect.any(String));
    await setMemberRole(db, g.id, x.id, manager);
    const self = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${x.id}`, cookies: await cookieOf(x.id), payload: { roleId: g.adminRoleId } });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ userId: x.id, roleId: g.adminRoleId, builtin: "admin" });
    expect(await roleOf(db, g.id, x.id)).toBe("admin");
    expect(await adminCount(db, g.id)).toBe(2);
  });

  it("kick: a regular member leaving on their own or an admin removing someone -> 204, changing role (up or down) -> 200, all call onGroupAccessChanged with (all notes of the group, [that one person]); changing to the same role and adding don't call it", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const leaver = await seedUser(db);
    const removed = await seedUser(db);
    const newcomer = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: leaver.id, role: "member" }, { userId: removed.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });
    await seedNote(db, { ownerId: admin.id }); // a note outside the group isn't in the list
    const groupNotes = [n1.id, n2.id].sort();
    const adminCookies = await cookieOf(admin.id);
    const expectLastCall = (userId: string): void => {
      const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls.at(-1)!;
      expect([...noteIds].sort()).toEqual(groupNotes);
      expect(userIds).toEqual([userId]);
    };

    expect((await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies: adminCookies, payload: { email: newcomer.email } })).statusCode).toBe(200);
    const same = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.memberRoleId } });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ userId: removed.id, roleId: g.memberRoleId, builtin: "member" });
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.adminRoleId } })).statusCode).toBe(200);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expectLastCall(removed.id);
    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.memberRoleId } })).statusCode).toBe(200);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expectLastCall(removed.id);

    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${leaver.id}`, cookies: await cookieOf(leaver.id) })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(3);
    expectLastCall(leaver.id);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(4);
    expectLastCall(removed.id);
  });

  it("#240 a regular member leaving the group with their own id in uppercase -> 204, member row deleted, the kick list has the lowercase id", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const leaver = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: leaver.id, role: "member" }]);
    await seedNote(db, { groupId: g.id });
    const res = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${leaver.id.toUpperCase()}`, cookies: await cookieOf(leaver.id) });
    expect(res.statusCode).toBe(204);
    expect(await roleOf(db, g.id, leaver.id)).toBeUndefined();
    expect(hooks.onGroupAccessChanged.mock.calls.at(-1)![1]).toEqual([leaver.id]);
  });

  it("concurrency: two admins leaving at the same time -> exactly one 204 and one 409 last_admin; exactly one built-in admin is left", async () => {
    let groupId = "";
    let second: Promise<LightMyRequestResponse> | undefined;
    let secondCookies: Record<string, string> = {};
    let secondUrl = "";
    let interleave: "blocked" | "settled" | undefined;
    // The hook is only called in requests after `built` is assigned, so the closure referencing a later-declared const doesn't hit the TDZ.
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second) return;
      second = built.app.inject({ method: "DELETE", url: secondUrl, cookies: secondCookies });
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const app: FastifyInstance = built.app;
    const a1 = await seedUser(built.db);
    const a2 = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [{ userId: a1.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    groupId = g.id;
    secondUrl = `/api/groups/${g.id}/members/${a2.id}`;
    secondCookies = await cookieOf(a2.id);

    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    const other = await second!;
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });
});

describe("#175 concurrency", () => {
  it("exactly two admins demote each other to regular member at the same time -> exactly one 200 and one 409 last_admin; exactly one built-in admin left", async () => {
    let groupId = "";
    // `fire` is assigned only once (after `built`) - put in a holder, since `let` would be blocked by prefer-const.
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    // The first request (role change) fires the second at "lock acquired, counted, before write" and waits for it to get stuck on lockGroup (or finish).
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const a = await seedUser(built.db);
    const b = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    groupId = g.id;
    const cookieB = await cookieOf(b.id);
    race.fire = () =>
      built.app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a.id}`, cookies: cookieB, payload: { roleId: g.memberRoleId } });

    const first = await built.app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(a.id), payload: { roleId: g.memberRoleId },
    });
    const other = await second!;
    expect([first.statusCode, other.statusCode].sort()).toEqual([200, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });

  it("a custom role holding canManageMembers demotes admin alice while another admin bob leaves -> demote 200, leave 409 last_admin; exactly one built-in admin left", async () => {
    let groupId = "";
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const alice = await seedUser(built.db);
    const bob = await seedUser(built.db);
    const x = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [
      { userId: alice.id, role: "admin" }, { userId: bob.id, role: "admin" }, { userId: x.id, role: "member" },
    ]);
    await setMemberRole(built.db, g.id, x.id, await seedRole(built.db, g.id, "Manager", { canRead: true, canManageMembers: true }));
    groupId = g.id;
    const cookieBob = await cookieOf(bob.id);
    race.fire = () => built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${bob.id}`, cookies: cookieBob });

    const first = await built.app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${alice.id}`, cookies: await cookieOf(x.id), payload: { roleId: g.memberRoleId },
    });
    const other = await second!;
    expect([first.statusCode, other.statusCode]).toEqual([200, 409]);
    expect(other.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });
});
