import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, upload, usedOf } from "./storage-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// In this file the default space-lock limit is 60 s (5000 ms in production), so the wall-clock bound of "the injected short limit took effect" stays far from both ends - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });
const deleteAll = async (app: FastifyInstance, groupId: string, userId: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });
const groupExists = async (pool: import("pg").Pool, id: string) => (await pool.query("select count(*)::int n from groups where id = $1", [id])).rows[0].n === 1;

describe("transfer", () => {
  it("recipient cannot fit -> 409, nothing happens (group, note ownership, redirects all intact)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 600);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 500);
    const before = await noteState(db.$client, gn.id);
    const r = await transfer(app, g.id, b.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 500, usedBytes: 600, quotaBytes: 1000 }));
    expect(await groupExists(db.$client, g.id)).toBe(true);
    expect(await noteState(db.$client, gn.id)).toEqual(before);
    expect((await db.$client.query("select count(*)::int n from note_redirects")).rows[0].n).toBe(0);
  });

  it("fits -> 204; recipient usage = own + sum of the group's attachments (including notes without attachments, several notes)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 100);
    for (const s of [200, 300]) {
      const n = await seedNote(db, { groupId: g.id });
      await seedAttachment(db, uploadsDir, n.id, b.id, s);
    }
    await seedNote(db, { groupId: g.id });
    expect((await transfer(app, g.id, b.id, b.id)).statusCode).toBe(204);
    expect(await usedOf(db.$client, { kind: "user", id: b.id })).toBe(600);
  });

  it("operator (manageGroup) is not the recipient -> incomingBytes only; site admin operating -> three numbers", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [op, b, site] = await Promise.all([seedUser(db), seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: op.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 10);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, op.id, 11);
    expect((await transfer(app, g.id, op.id, b.id)).json()).toEqual(quotaBody({ incomingBytes: 11 }));
    expect((await transfer(app, g.id, site.id, b.id)).json()).toEqual(quotaBody({ incomingBytes: 11, usedBytes: 0, quotaBytes: 10 }));
  });

  it("recipient already over quota -> transfer with attachments 409; group without attachments -> 204; delete-all -> group usage disappears with it", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, 10);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 50);
    const g1 = await seedGroup(db, "G1", [{ userId: b.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g1.id });
    await seedAttachment(db, uploadsDir, n1.id, b.id, 1);
    expect((await transfer(app, g1.id, b.id, b.id)).statusCode).toBe(409);
    const g2 = await seedGroup(db, "G2", [{ userId: b.id, role: "admin" }]);
    await seedNote(db, { groupId: g2.id });
    expect((await transfer(app, g2.id, b.id, b.id)).statusCode).toBe(204);
    await giveGroupQuota(db, g1.id, null);
    expect(await usedOf(db.$client, { kind: "group", id: g1.id })).toBe(1);
    expect((await deleteAll(app, g1.id, b.id)).statusCode).toBe(204);
    expect(await usedOf(db.$client, { kind: "group", id: g1.id })).toBe(0);
  });
});

describe("busy mapping (group delete)", () => {
  for (const code of ["40P01", "55P03"]) {
    it(`transfer: test hook storage-space-locked throws ${code} -> 409 server_busy, group intact`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const b = await seedUser(db);
      const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
      const gn = await seedNote(db, { groupId: g.id });
      await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
      const r = await transfer(app, g.id, b.id, b.id);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("server_busy");
      expect(await groupExists(db.$client, g.id)).toBe(true);
    });
  }

  it("delete-all: group-delete-locked throws 55P03 -> 409 server_busy (the existing mapping now also recognises 55P03)", async () => {
    const { app, db } = await buildTestApp({
      groupTestHook: async point => { if (point === "group-delete-locked") throw Object.assign(new Error("55P03"), { code: "55P03" }); },
    });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const r = await deleteAll(app, g.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("server_busy");
  });
});

describe("the transfer's space lock: position and wait limit", () => {
  it("space lock before the slug write: folder-structure-locked and storage-space-locked come in that order before the first group-transfer-slug-candidate; at the slug probe this DB already holds 3 advisory locks", async () => {
    const points: string[] = [];
    const advisoryAtSlug: number[] = [];
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point === "group-transfer-slug-candidate") {
          // Count only this test database's advisory locks (other test databases may exist on the same PG).
          const { rows } = await built.db.$client.query(
            "select count(*)::int n from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())",
          );
          advisoryAtSlug.push(rows[0].n);
        }
        points.push(point);
      },
    });
    const { app, db, uploadsDir } = built;
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
    expect((await transfer(app, g.id, b.id, b.id)).statusCode).toBe(204);
    expect(points).toEqual(["group-delete-locked", "folder-structure-locked", "storage-space-locked", "group-transfer-slug-candidate"]);
    // At the slug probe this DB holds 3 advisory locks = 2 structure locks (the group and the recipient's personal space) + 1 capacity lock.
    expect(advisoryAtSlug).toEqual([3]);
  });

  it("storageLockTimeoutMs=200: transfer while upload A (stopped at the hook) holds the recipient's personal space lock -> a real 55P03 -> 409 server_busy (< 20 s: the injected value reached the transfer transaction, not this file's default 60 s), group intact; A is 201 afterwards", async () => {
    const holder: { app?: FastifyInstance; groupId?: string; userId?: string; noteId?: string; t?: LightMyRequestResponse; tMs?: number } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async (point, ctx) => {
        // Fire one transfer only while upload A (ctx.noteId = the recipient's personal note) is stopped at the hook; the transfer times out at its lock statement and never reaches this hook.
        if (point !== "storage-space-locked" || ctx.noteId !== holder.noteId || holder.t) return;
        const t0 = Date.now();
        holder.t = await transfer(holder.app!, holder.groupId!, holder.userId!, holder.userId!);
        holder.tMs = Date.now() - t0;
      },
    });
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
    Object.assign(holder, { app, groupId: g.id, userId: b.id, noteId: bn.id });
    const a = await upload(app, bn.id, b.id, 10);
    expect(holder.t!.statusCode).toBe(409);
    expect(holder.t!.json().error.code).toBe("server_busy");
    // The 20 s bound sits between 200 ms and this file's default 60 s: if the route did not pass deps.storageLockTimeoutMs into the transaction (falling back to the default), the transfer would wait about 60 s before timing out -> red.
    expect(holder.tMs!).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    expect(await groupExists(db.$client, g.id)).toBe(true);
    expect(a.statusCode).toBe(201);
  });
});
