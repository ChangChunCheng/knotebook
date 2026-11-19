/**
 * Any ordering must not return 500. Delete first: holds lockGroup, the create's INSERT blocks on the FK KEY SHARE (shows as Lock in pg_stat_activity), and after the delete commits gets 23503 -> 404 group_not_found.
 * Create first: commits, and the delete picks the note up through the group predicate (transfer: becomes transferTo's personal note; delete all: deleted with the group).
 * Also: deleting an empty group (delete-all mode) x concurrent add member, where `addMemberInTx`'s lockGroup decides between 404 and 500.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { groupMembers, groups, notes } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";

describe("#175 delete group x concurrent create", () => {
  it("delete (transfer) takes the lock first (group-delete-locked) -> create blocks on the FK -> delete 204, create 404 group_not_found, no orphan row", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { pool?: import("pg").Pool } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "group-delete-locked" || !state.fire || state.second) return;
        state.second = state.fire();
        state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
      },
    });
    holder.pool = built.db.$client;
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () => built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "late" } });
    const del = await built.app.inject({
      method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
    });
    const create = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe("group_not_found");
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(notes).where(eq(notes.title, "late"))).toEqual([]);
  });

  it("transfer and create in either order (transfer fired after membership-checked): create first -> 201/204 and the note becomes transferTo's personal note; transfer first -> 404/204, no orphan", async () => {
    const state: { second?: Promise<LightMyRequestResponse>; fire?: () => Promise<LightMyRequestResponse> } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "membership-checked" || !state.fire || state.second) return;
        state.second = state.fire(); // create usually finishes first (not guaranteed; both outcomes accepted, see below)
      },
    });
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () =>
      built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id } });
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    const del = await state.second!;
    // Either outcome is possible (who gets the groups row lock first depends on scheduling), but neither is a 500 and the group is gone.
    const outcome = `${create.statusCode}/${del.statusCode}`;
    expect(["201/204", "404/204"]).toContain(outcome);
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    const rows = await built.db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.title, "early"));
    if (outcome === "201/204") expect(rows).toEqual([{ ownerId: admin.id, groupId: null }]);
    else {
      expect(create.json().error.code).toBe("group_not_found");
      expect(rows).toEqual([]);
    }
  });

  it("delete all and create in either order (delete all fired after membership-checked): create first -> 201/204 and the note is deleted; delete all first -> 404/204; no orphans", async () => {
    const state: { second?: Promise<LightMyRequestResponse>; fire?: () => Promise<LightMyRequestResponse> } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "membership-checked" || !state.fire || state.second) return;
        state.second = state.fire();
      },
    });
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () =>
      built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "delete" } });
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    const del = await state.second!;
    const outcome = `${create.statusCode}/${del.statusCode}`;
    expect(["201/204", "404/204"]).toContain(outcome);
    if (outcome === "404/204") expect(create.json().error.code).toBe("group_not_found");
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(await built.db.select().from(notes).where(eq(notes.title, "early"))).toEqual([]);
  });

  it("create commits first (sequential: await the create, then delete) -> transfer picks the note up", async () => {
    const built = await buildTestApp();
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    expect(create.statusCode).toBe(201);
    const del = await built.app.inject({
      method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
    });
    expect(del.statusCode).toBe(204);
    expect(await built.db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.title, "early"))).toEqual([
      { id: create.json().id, ownerId: admin.id, groupId: null },
    ]);
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("deleting an empty group x concurrent add member: delete takes the lock first -> PUT .../members blocks on the add's lockGroup -> delete 204, add 404 not_found (not 500), no member row", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { pool?: import("pg").Pool } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "group-delete-locked" || !state.fire || state.second) return;
        state.second = state.fire();
        state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
      },
    });
    holder.pool = built.db.$client;
    const [admin, newcomer] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    state.fire = () => built.app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: newcomer.email } });
    const del = await built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies, payload: { mode: "delete" } });
    const put = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual({ error: { code: "not_found", message: "No group with that id." } });
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(groupMembers).where(eq(groupMembers.userId, newcomer.id))).toEqual([]);
  });
});
