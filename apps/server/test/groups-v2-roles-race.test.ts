/**
 * Lock order: member and role changes all take the groups row lock. The first request pauses in a test hook (lock held, before the write), fires the second request,
 * and `waitForBlockedOrSettled` (Lock waits in `pg_stat_activity`) proves the second really waits - no timing assumptions. The helper only counts Lock waits and
 * can't tell which lock; the only row lock held at that point is the groups row.
 *
 * The last test ("groups FOR KEY SHARE") pins a cross-feature premise: the move path takes only `FOR KEY SHARE` on the groups row before reading membership, so its
 * correctness relies on every write to `group_members` or role flags doing `lockGroup` first (groups FOR UPDATE, which conflicts with KEY SHARE).
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import type { GroupTestHook, GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedRole, seedUser, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";

const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };

async function membersOf(app: FastifyInstance, groupId: string, cookies: Record<string, string>): Promise<GroupMemberDto[]> {
  const res = await app.inject({ method: "GET", url: `/api/groups/${groupId}/members`, cookies });
  expect(res.statusCode).toBe(200);
  return res.json() as GroupMemberDto[];
}

async function roleIdsOf(app: FastifyInstance, groupId: string, cookies: Record<string, string>): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: `/api/groups/${groupId}/roles`, cookies });
  expect(res.statusCode).toBe(200);
  return (res.json() as GroupRoleDto[]).map(r => r.id);
}

async function raceScene(at: GroupRacePoint) {
  let groupId = "";
  const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
  const state: { second?: Promise<LightMyRequestResponse>; interleave?: "blocked" | "settled" } = {};
  const hook: GroupTestHook = async (point, ctx) => {
    if (point !== at || ctx.groupId !== groupId || state.second || !race.fire) return;
    state.second = race.fire();
    state.interleave = await waitForBlockedOrSettled(built.db.$client, state.second);
  };
  const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
  const a = await seedUser(built.db);
  const b = await seedUser(built.db);
  const d = await seedUser(built.db);
  const g = await seedGroup(built.db, "Race", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
  groupId = g.id;
  const x = await seedRole(built.db, g.id, "X", { canRead: true, canEdit: true });
  return { app: built.app, a, b, d, g, x, race, state, cookies: await cookieOf(a.id) };
}

describe("#175: deleting a custom role vs assigning someone to it (serialized by the same groups row lock)", () => {
  it("changing B to X first: DELETE X fired while the change is paused before its write -> PATCH 200, DELETE 204; B ends up on the built-in plain member role and X is gone", async () => {
    const { app, b, g, x, race, state, cookies } = await raceScene("group-members-checked");
    race.fire = () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const first = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: x } });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ userId: b.id, roleId: x, builtin: null });
    expect(second.statusCode, second.body).toBe(204);
    expect((await membersOf(app, g.id, cookies)).find(m => m.userId === b.id)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect(await roleIdsOf(app, g.id, cookies)).not.toContain(x);
    expect(state.interleave).toBe("blocked");
  });

  it("deleting X first: \"change B to X\" fired while the delete is paused before its write -> DELETE 204, PATCH 404 role_not_found; B stays on the built-in plain member role", async () => {
    const { app, b, g, x, race, state, cookies } = await raceScene("group-roles-checked");
    race.fire = () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: x } });
    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(204);
    expect(second.statusCode, second.body).toBe(404);
    expect(second.json()).toEqual({ error: { code: "role_not_found", message: "No role with that id." } });
    expect((await membersOf(app, g.id, cookies)).find(m => m.userId === b.id)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect(await roleIdsOf(app, g.id, cookies)).not.toContain(x);
    expect(state.interleave).toBe("blocked");
  });

  it("deleting X first vs add member: \"add D with X\" fired while the delete is paused before its write -> DELETE 204, PUT 404 role_not_found; D is not a member", async () => {
    const { app, d, g, x, race, state, cookies } = await raceScene("group-roles-checked");
    race.fire = () => app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: d.email, roleId: x } });
    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(204);
    expect(second.statusCode, second.body).toBe(404);
    expect(second.json()).toEqual({ error: { code: "role_not_found", message: "No role with that id." } });
    expect((await membersOf(app, g.id, cookies)).map(m => m.userId)).not.toContain(d.id);
    expect(state.interleave).toBe("blocked");
  });
});

describe("#175 cross-feature premise: role and member writes all take lockGroup first (groups FOR UPDATE)", () => {
  it("while another transaction holds FOR KEY SHARE on the groups row, PATCH/DELETE role and PUT/PATCH/DELETE member all block and complete only after the other commits", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const pool = db.$client;
    const a = await seedUser(db);
    const b = await seedUser(db);
    const c = await seedUser(db);
    const d = await seedUser(db);
    const g = await seedGroup(db, "Locked", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }, { userId: c.id, role: "member" }]);
    const cookies = await cookieOf(a.id);
    const patchMe = await seedRole(db, g.id, "PatchMe", { canRead: true, canEdit: true });
    const deleteMe = await seedRole(db, g.id, "DeleteMe", { canRead: true });
    const cases: Array<{ label: string; send: () => Promise<LightMyRequestResponse>; status: number }> = [
      { label: "PATCH role", status: 200, send: () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${patchMe}`, cookies, payload: { permissions: NONE } }) },
      { label: "DELETE role", status: 204, send: () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${deleteMe}`, cookies }) },
      { label: "PUT member", status: 200, send: () => app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: d.email } }) },
      { label: "PATCH member", status: 200, send: () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: patchMe } }) },
      { label: "DELETE member", status: 204, send: () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${c.id}`, cookies }) },
    ];
    for (const { label, send, status } of cases) {
      const holder = await pool.connect();
      let pending: Promise<LightMyRequestResponse> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select id from groups where id = $1 for key share", [g.id]);
        pending = send();
        expect(await waitForBlockedOrSettled(pool, pending), label).toBe("blocked");
        await holder.query("commit");
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      const res = await pending!;
      expect(res.statusCode, `${label}：${res.body}`).toBe(status);
    }
  });
});
