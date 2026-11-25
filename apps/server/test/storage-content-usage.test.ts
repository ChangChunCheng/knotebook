import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../src/db/index.js";
import { noteStateBackups, noteStates, noteVersions, notes } from "../src/db/schema.js";
import { adminApp } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, seedAttachment, seedPlan, upload } from "./storage-helpers.js";

type B = Awaited<ReturnType<typeof adminApp>>;

async function seedContent(db: Db, noteId: string, sizes: { state?: number; versions?: number[]; backups?: number[] }): Promise<void> {
  if (sizes.state !== undefined) await db.insert(noteStates).values({ noteId, ydoc: Buffer.alloc(sizes.state, 1) });
  let seq = 1;
  for (const n of sizes.versions ?? []) await db.insert(noteVersions).values({ noteId, seq: seq++, ydoc: Buffer.alloc(n, 2), kind: "manual" });
  for (const n of sizes.backups ?? []) await db.insert(noteStateBackups).values({ noteId, ydoc: Buffer.alloc(n, 3) });
}

/** Direct per-table sum, used as the expected value. */
async function rawContent(b: B, col: "owner_id" | "group_id", id: string): Promise<{ noteBytes: number; historyBytes: number }> {
  const c = sql.raw(`x.${col}`);
  const res = await b.db.execute<{ n: string; h: string }>(sql`
    select
      (select coalesce(sum(octet_length(s.ydoc)), 0) from note_states s join notes x on x.id = s.note_id where ${c} = ${id})::bigint::text as n,
      ((select coalesce(sum(octet_length(v.ydoc)), 0) from note_versions v join notes x on x.id = v.note_id where ${c} = ${id})
       + (select coalesce(sum(octet_length(k.ydoc)), 0) from note_state_backups k join notes x on x.id = k.note_id where ${c} = ${id}))::bigint::text as h`);
  return { noteBytes: Number(res.rows[0]!.n), historyBytes: Number(res.rows[0]!.h) };
}

const get = async (b: B, url: string, userId: string) => (await b.app.inject({ method: "GET", url, cookies: await cookieOf(userId) })).json();

describe("content usage in GET /api/storage", () => {
  it("two personal spaces: exact per-table octet_length sums, states not multiplied by versions, no bleed between users; usedBytes is unchanged", async () => {
    const b = await adminApp();
    const alice = await seedUser(b.db);
    const bob = await seedUser(b.db);
    const a1 = await seedNote(b.db, { ownerId: alice.id });
    const a2 = await seedNote(b.db, { ownerId: alice.id });
    const b1 = await seedNote(b.db, { ownerId: bob.id });
    await seedContent(b.db, a1.id, { state: 1000, versions: [300, 200, 100], backups: [50, 70] });
    await seedContent(b.db, a2.id, { state: 500 });
    await seedContent(b.db, b1.id, { state: 4000, versions: [9000], backups: [11] });
    const perTable = async (table: string, id: string) => {
      const r = await b.db.execute<{ s: string }>(sql`select coalesce(sum(octet_length(t.ydoc)), 0)::bigint::text as s from ${sql.raw(table)} t join notes x on x.id = t.note_id where x.owner_id = ${id}`);
      return Number(r.rows[0]!.s);
    };
    const aliceBody = await get(b, "/api/storage", alice.id);
    expect(aliceBody.content.noteBytes).toBe(await perTable("note_states", alice.id));
    expect(aliceBody.content.historyBytes).toBe((await perTable("note_versions", alice.id)) + (await perTable("note_state_backups", alice.id)));
    expect(aliceBody.content).toEqual({ noteBytes: 1500, historyBytes: 720 });
    expect(aliceBody.content).toEqual(await rawContent(b, "owner_id", alice.id));
    expect(aliceBody.usedBytes).toBe(0);
    expect(typeof aliceBody.content.noteBytes).toBe("number");
    const bobBody = await get(b, "/api/storage", bob.id);
    expect(bobBody.content).toEqual({ noteBytes: 4000, historyBytes: 9011 });
    expect(bobBody.content).toEqual(await rawContent(b, "owner_id", bob.id));
  });

  it("empty user and a note with no versions or backups give zeros", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 0, historyBytes: 0 });
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, n.id, { state: 10 });
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 10, historyBytes: 0 });
    const m = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, m.id, { versions: [7] });
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 10, historyBytes: 7 });
  });

  it("a group note counts for the group, not for its creator's personal space", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const g = await seedGroup(b.db, "G", [{ userId: u.id, role: "admin" }]);
    const gn = await seedNote(b.db, { groupId: g.id });
    await seedContent(b.db, gn.id, { state: 400, versions: [100] });
    const pn = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, pn.id, { state: 30 });
    expect((await get(b, `/api/groups/${g.id}/storage`, u.id)).content).toEqual({ noteBytes: 400, historyBytes: 100 });
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 30, historyBytes: 0 });
  });

  it("trashed notes are counted; a permanently deleted note drops out", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, n.id, { state: 100, versions: [20], backups: [3] });
    await b.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, n.id));
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 100, historyBytes: 23 });
    await b.db.delete(notes).where(eq(notes.id, n.id));
    expect((await get(b, "/api/storage", u.id)).content).toEqual({ noteBytes: 0, historyBytes: 0 });
  });
});

describe("contentBytes on admin rows", () => {
  it("GET /api/admin/users and /api/admin/groups carry note + history for several spaces at once; spaces without content get 0", async () => {
    const b = await adminApp();
    const alice = await seedUser(b.db);
    const bob = await seedUser(b.db);
    const g1 = await seedGroup(b.db, "G1", [{ userId: alice.id, role: "admin" }]);
    const g2 = await seedGroup(b.db, "G2", []);
    const empty = await seedGroup(b.db, "Empty", []);
    const an = await seedNote(b.db, { ownerId: alice.id });
    await seedContent(b.db, an.id, { state: 40, versions: [5], backups: [6] });
    const bn = await seedNote(b.db, { ownerId: bob.id });
    await seedContent(b.db, bn.id, { state: 100, versions: [20, 30] });
    const g1n = await seedNote(b.db, { groupId: g1.id });
    await seedContent(b.db, g1n.id, { state: 70, backups: [9] });
    const g2n = await seedNote(b.db, { groupId: g2.id });
    await seedContent(b.db, g2n.id, { state: 1000, versions: [1] });
    const users = (await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies })).json();
    const byId = (rows: Array<{ id: string; storage: { contentBytes: number } }>, id: string) => rows.find(r => r.id === id)!.storage.contentBytes;
    expect(byId(users, alice.id)).toBe(51);
    expect(byId(users, bob.id)).toBe(150);
    expect(byId(users, b.admin.id)).toBe(0);
    const groups = (await b.app.inject({ method: "GET", url: "/api/admin/groups", cookies: b.cookies })).json();
    expect(byId(groups, g1.id)).toBe(79);
    expect(byId(groups, g2.id)).toBe(1001);
    expect(byId(groups, empty.id)).toBe(0);
  });

  it("both PATCH storage-plan responses carry contentBytes", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const g = await seedGroup(b.db, "G", []);
    const p = await seedPlan(b.db, "P", null);
    const pn = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, pn.id, { state: 11, versions: [4] });
    const gn = await seedNote(b.db, { groupId: g.id });
    await seedContent(b.db, gn.id, { state: 8 });
    const ru = await b.app.inject({ method: "PATCH", url: `/api/admin/users/${u.id}/storage-plan`, cookies: b.cookies, payload: { planId: p } });
    expect(ru.json().storage.contentBytes).toBe(15);
    const rg = await b.app.inject({ method: "PATCH", url: `/api/admin/groups/${g.id}/storage-plan`, cookies: b.cookies, payload: { planId: p } });
    expect(rg.json().storage.contentBytes).toBe(8);
  });
});

describe("content bytes stay out of the limit", () => {
  it("a plan smaller than the content: overQuotaCount stays 0, usedBytes is attachments only, and an upload within the limit succeeds", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const g = await seedGroup(b.db, "G", [{ userId: u.id, role: "admin" }]);
    const pn = await seedNote(b.db, { ownerId: u.id });
    await seedContent(b.db, pn.id, { state: 5000, versions: [5000] });
    const gn = await seedNote(b.db, { groupId: g.id });
    await seedContent(b.db, gn.id, { state: 5000, versions: [5000] });
    const planId = await giveUserQuota(b.db, u.id, 1000);
    await giveGroupQuota(b.db, g.id, 1000);
    await seedAttachment(b.db, b.uploadsDir, pn.id, u.id, 100);
    const plans = (await b.app.inject({ method: "GET", url: "/api/admin/storage-plans", cookies: b.cookies })).json();
    expect(plans.plans.find((p: { id: string }) => p.id === planId).overQuotaCount).toBe(0);
    expect(plans.plans.every((p: { overQuotaCount: number }) => p.overQuotaCount === 0)).toBe(true);
    const usage = await get(b, "/api/storage", u.id);
    expect(usage.usedBytes).toBe(100);
    expect(usage.content.noteBytes).toBe(5000);
    expect((await upload(b.app, pn.id, u.id, 600)).statusCode).toBe(201);
    expect((await upload(b.app, gn.id, u.id, 600)).statusCode).toBe(201);
  });
});
