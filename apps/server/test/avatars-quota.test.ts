import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";
import { adminApp } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, seedAttachment, seedPlan, setUserPlan, usedOf } from "./storage-helpers.js";
import { seedAvatarRow } from "./avatar-helpers.js";
import { StorageQuotaExceeded, assertSpaceRoomInTx } from "../src/storage/tx/quota.js";
import { listSpaceUsage, readSpaceUsage, readSpaceUsageByKind } from "../src/storage/usage.js";

const opts = { lockTimeoutMs: 60_000 };

describe("avatar usage counts toward personal space", () => {
  it("readSpaceUsage(user) = attachments + avatars (original_size + display_size byte for byte); other people's avatars don't count", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    // avatar-only user (no attachments) still counts
    await seedAvatarRow(db, { userId: bob.id, originalSize: 9000, displaySize: 900, isCurrent: true });
    const usage = await readSpaceUsage(db, { kind: "user", id: alice.id });
    expect(usage?.usedBytes).toBe(400 + 5000 + 300 + 70);
    expect(typeof usage?.usedBytes).toBe("number");
    expect((await readSpaceUsage(db, { kind: "user", id: bob.id }))?.usedBytes).toBe(9900);
  });

  it("group space excludes avatars: a member has an avatar, group usage unchanged", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, alice.id, 250);
    const before = await readSpaceUsage(db, { kind: "group", id: g.id });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const after = await readSpaceUsage(db, { kind: "group", id: g.id });
    expect(before?.usedBytes).toBe(250);
    expect(after?.usedBytes).toBe(250);
    expect((await listSpaceUsage(db, "group")).get(g.id)).toBe(250);
  });

  it("assertSpaceRoomInTx: quota 1000, attachments 400, avatar 500 -> needing 100 passes, 101 throws StorageQuotaExceeded (usedBytes includes avatars)", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 400, displaySize: 100, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 100, opts));
    const err = await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 101, opts)).catch(e => e);
    expect(err).toBeInstanceOf(StorageQuotaExceeded);
    expect(err).toMatchObject({ usedBytes: 900, quotaBytes: 1000, incomingBytes: 101 });
  });

  it("assertSpaceRoomInTx: other people's avatars don't take alice's quota", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    await seedAvatarRow(db, { userId: bob.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 1000, opts));
  });

  it("assertSpaceRoomInTx: group space quota is unaffected by members' avatars", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 100);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id }, 100, opts));
  });

  it("listSpaceUsage(user): carol with only an avatar and no attachments is in the Map; alice (both) has the sum; dave with nothing isn't there", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const carol = await seedUser(db);
    const dave = await seedUser(db);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 1000, displaySize: 20, isCurrent: true });
    await seedAvatarRow(db, { userId: carol.id, originalSize: 800, displaySize: 60, isCurrent: true });
    // non-current candidates also take quota
    await seedAvatarRow(db, { userId: alice.id, originalSize: 300, displaySize: 10, isCurrent: false });
    const m = await listSpaceUsage(db, "user");
    expect(m.get(alice.id)).toBe(1730);
    expect(m.get(carol.id)).toBe(860);
    expect(typeof m.get(carol.id)).toBe("number");
    expect(m.has(dave.id)).toBe(false);
  });

  it("readSpaceUsageByKind: a user's avatar total is folded into image; groups have no avatars", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: alice.id });
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAttachment(db, uploadsDir, gn.id, alice.id, 30);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    // avatar-only user: everything is in image
    await seedAvatarRow(db, { userId: bob.id, originalSize: 9000, displaySize: 900, isCurrent: true });
    expect(await readSpaceUsageByKind(db, { kind: "user", id: alice.id })).toEqual({ image: 5770, audio: 0, video: 0, document: 0, other: 0 });
    expect(await readSpaceUsageByKind(db, { kind: "group", id: g.id })).toEqual({ image: 30, audio: 0, video: 0, document: 0, other: 0 });
    expect(await readSpaceUsageByKind(db, { kind: "user", id: bob.id })).toEqual({ image: 9900, audio: 0, video: 0, document: 0, other: 0 });
  });

  it("GET /api/storage: avatars count in byKind.image, sum of kinds = usedBytes", async () => {
    const b = await buildTestApp();
    const alice = await seedUser(b.db);
    const n = await seedNote(b.db, { ownerId: alice.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(b.db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const body = (await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(alice.id) })).json();
    expect(body.byKind).toEqual({ image: 5700, audio: 0, video: 0, document: 0, other: 0 });
    expect(body.usedBytes).toBe(5700);
    expect(Object.values(body.byKind as Record<string, number>).reduce((a, x) => a + x, 0)).toBe(body.usedBytes);
  });

  it("GET /api/groups/:id/storage: group byKind excludes avatars", async () => {
    const b = await buildTestApp();
    const alice = await seedUser(b.db);
    const g = await seedGroup(b.db, "G", [{ userId: alice.id, role: "admin" }]);
    await seedAvatarRow(b.db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const body = (await b.app.inject({ method: "GET", url: `/api/groups/${g.id}/storage`, cookies: await cookieOf(alice.id) })).json();
    expect(body.byKind.image).toBe(0);
    expect(body.usedBytes).toBe(0);
  });

  it("GET /api/admin/users: usage column includes avatars (a user with only an avatar has a value too)", async () => {
    const b = await adminApp();
    const carol = await seedUser(b.db);
    await giveUserQuota(b.db, carol.id, 10_000);
    await seedAvatarRow(b.db, { userId: carol.id, originalSize: 800, displaySize: 60, isCurrent: true });
    const list = (await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies })).json();
    const row = list.find((r: { id: string }) => r.id === carol.id);
    expect(row.storage.usedBytes).toBe(860);
    expect(row.storage.quotaBytes).toBe(10_000);
    // The attachments' ad-hoc SQL doesn't include avatars: all 860 comes from avatars
    expect(await usedOf(b.db.$client, { kind: "user", id: carol.id })).toBe(0);
  });

  it("GET /api/admin/storage-plans: usage of overQuotaCount users includes avatars (carol over quota with only an avatar counts one; bob exactly at the limit doesn't; eve whose current avatar is within quota but who exceeds it with a non-current candidate counts one)", async () => {
    const b = await adminApp();
    const carol = await seedUser(b.db);
    const bob = await seedUser(b.db);
    const plan = await seedPlan(b.db, "Small", 1000);
    await setUserPlan(b.db, carol.id, plan);
    await setUserPlan(b.db, bob.id, plan);
    await seedAvatarRow(b.db, { userId: carol.id, originalSize: 900, displaySize: 101, isCurrent: true });
    await seedAvatarRow(b.db, { userId: bob.id, originalSize: 900, displaySize: 100, isCurrent: true });
    // eve's current avatar 500 is within quota; only with the non-current candidate 501 does she exceed it
    const eve = await seedUser(b.db);
    await setUserPlan(b.db, eve.id, plan);
    await seedAvatarRow(b.db, { userId: eve.id, originalSize: 400, displaySize: 100, isCurrent: true });
    await seedAvatarRow(b.db, { userId: eve.id, originalSize: 400, displaySize: 101, isCurrent: false });
    const plans = (await b.app.inject({ method: "GET", url: "/api/admin/storage-plans", cookies: b.cookies })).json().plans;
    expect(plans.find((x: { id: string }) => x.id === plan)).toMatchObject({ userCount: 3, overQuotaCount: 2 });
  });
});
