/** The image server is a local `node:http`; except for the cases testing the production address policy, the download policy is injected to allow loopback and any port. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AvatarFetchPolicy } from "../src/avatars/oidc-fetch.js";
import type { Db } from "../src/db/index.js";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";

const ISSUER = "https://idp.example";
const OPEN_POLICY: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };

/** A PNG whose content is determined by `fill` (same signature, different bytes -> different sha256). */
function pngFilled(size: number, fill: number): Buffer {
  const b = pngOf(size);
  b.fill(fill, 8);
  return b;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

interface ImageRoute {
  status?: number;
  body?: Buffer;
  /** After the request arrives, the response waits for this Promise. */
  hold?: Promise<void>;
}

async function imageServer(routes: Record<string, ImageRoute>): Promise<{ base: string; requests: () => number; arrived: () => Promise<void> }> {
  let count = 0;
  let onFirst: () => void = () => {};
  const first = new Promise<void>(r => (onFirst = r));
  const server = createServer((req, res) => {
    count++;
    onFirst();
    const route = routes[(req.url ?? "").split("?")[0]!];
    void (async () => {
      if (route?.hold) await route.hold;
      if (!route) return void res.writeHead(404).end();
      res.writeHead(route.status ?? 200, { "content-type": "image/png" });
      res.end(route.body ?? Buffer.alloc(0));
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => count, arrived: () => first };
}

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

async function seedIdentity(db: Db, userId: string, over: { lastPictureUrl?: string | null; dismissed?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(userIdentities)
    .values({
      userId,
      issuer: ISSUER,
      sub: `sub-${randomUUID()}`,
      lastPictureUrl: over.lastPictureUrl === undefined ? null : over.lastPictureUrl,
      pictureDismissedUrl: over.dismissed === undefined ? null : over.dismissed,
    })
    .returning({ id: userIdentities.id });
  return row!.id;
}

const refresh = async (app: Ctx["app"], userId: string | null, identityId: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/auth/avatars/oidc/${identityId}/refresh`,
    ...(userId !== null ? { cookies: await cookieOf(userId) } : {}),
    headers,
  });

const rowsOf = (db: Db, userId: string) => db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
const identityOf = async (db: Db, id: string) => (await db.select().from(userIdentities).where(eq(userIdentities.id, id)))[0]!;
const autoOf = async (db: Db, userId: string) => (await db.select({ a: users.avatarAuto }).from(users).where(eq(users.id, userId)))[0]!.a;
const usedBytes = async (db: Db, userId: string) => (await readSpaceUsage(db, { kind: "user", id: userId }))!.usedBytes;
const filesOf = async (dir: string) => (await readdir(dir)).sort();

function logCollector() {
  const out: string[] = [];
  return { out, logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } };
}

async function giveDisplay(db: Db, id: string): Promise<void> {
  await db
    .update(userAvatars)
    .set({ cropX: 1, cropY: 2, cropSize: 30, originalWidth: 40, originalHeight: 50, displayData: Buffer.alloc(120, 0x41), displayMime: "image/webp", displaySize: 120 })
    .where(eq(userAvatars.id, id));
}

describe("POST /api/auth/avatars/oidc/:identityId/refresh: success", () => {
  it("the user had deleted this one -> 200 returns the list: the candidate is back and is the current avatar, avatar_auto = false, picture_dismissed_url cleared, refreshable no longer contains it; usage and files add up", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await seedAuthProvider(db, { issuerUrl: ISSUER, displayName: "Company SSO" });
    const picture = `${img.base}/a.png`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    expect(await autoOf(db, alice.id)).toBe(true);
    const listed = await app.inject({ method: "GET", url: "/api/auth/avatars", cookies: await cookieOf(alice.id) });
    expect(listed.json().refreshable).toEqual([{ identityId, providerName: "Company SSO" }]);

    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.refreshable).toEqual([]);
    expect(body.auto).toBe(false);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ source: "oidc", providerName: "Company SSO", current: true, pending: true });
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ identityId, oidcPictureUrl: picture, isCurrent: true, originalSize: 500, version: 1 });
    expect(await autoOf(db, alice.id)).toBe(false);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBeNull();
    expect(await filesOf(uploadsDir)).toEqual([rows[0]!.originalFile]);
    expect(await usedBytes(db, alice.id)).toBe(500);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(me.json().avatar).toMatchObject({ id: rows[0]!.id, pending: true });
  });

  it("a candidate for this identity already exists (different bytes) -> replaced in place and selected: same id, version + 1, crop and display image cleared, old file deleted, the uploaded one is no longer the current avatar", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/new.png": { body: pngFilled(700, 2) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/new.png` });
    const [old] = await db
      .insert(userAvatars)
      .values({
        userId: alice.id,
        source: "oidc",
        identityId,
        oidcPictureUrl: `${img.base}/old.png`,
        originalFile: randomUUID(),
        originalSha256: Buffer.alloc(32, 9),
        originalMime: "image/png",
        originalSize: 300,
      })
      .returning();
    await giveDisplay(db, old!.id);
    const [upload] = await db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning();
    const usedBefore = await usedBytes(db, alice.id);
    await writeFile(uploadFilePath(uploadsDir, old!.originalFile), pngFilled(300, 9));
    expect(await filesOf(uploadsDir)).toEqual([old!.originalFile]);

    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    const replaced = rows.find(r => r.id === old!.id)!;
    expect(replaced).toMatchObject({ isCurrent: true, version: 2, displayData: null, displaySize: 0, cropX: null, originalWidth: null, originalSize: 700, oidcPictureUrl: `${img.base}/new.png` });
    expect(rows.find(r => r.id === upload!.id)!.isCurrent).toBe(false);
    expect(await autoOf(db, alice.id)).toBe(false);
    expect(await usedBytes(db, alice.id)).toBe(usedBefore + (700 - 300 - 120));
    expect(await filesOf(uploadsDir)).toEqual([replaced.originalFile]);
    expect(existsSync(path.join(uploadsDir, old!.originalFile))).toBe(false);
  });

  it("same bytes -> original not replaced, version not bumped, display image kept, but still selected; the newly downloaded file isn't kept", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const bytes = pngFilled(400, 3);
    const img = await imageServer({ "/a.png": { body: bytes } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const { createHash } = await import("node:crypto");
    const [cand] = await db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "oidc", identityId, oidcPictureUrl: `${img.base}/a.png`, originalFile: randomUUID(), originalSha256: createHash("sha256").update(bytes).digest(), originalMime: "image/png", originalSize: 400 })
      .returning();
    await giveDisplay(db, cand!.id);
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await rowsOf(db, alice.id);
    expect(row).toMatchObject({ id: cand!.id, isCurrent: true, version: 1, displaySize: 120, originalFile: cand!.originalFile });
    expect(await autoOf(db, alice.id)).toBe(false);
    expect(await filesOf(uploadsDir)).toEqual([]);
  });

  it("bystander: completely unaffected when bob has same-shaped data (identity, dismissed URL, current avatar)", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const picture = `${img.base}/a.png`;
    const aliceIdentity = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: picture, dismissed: picture });
    const [bobAvatar] = await db
      .insert(userAvatars)
      .values({ userId: bob.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 5), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning();
    const res = await refresh(app, alice.id, aliceIdentity);
    expect(res.statusCode, res.body).toBe(200);
    expect((await identityOf(db, bobIdentity)).pictureDismissedUrl).toBe(picture);
    expect(await autoOf(db, bob.id)).toBe(true);
    expect(await rowsOf(db, bob.id)).toEqual([bobAvatar]);
  });
});

describe("POST /api/auth/avatars/oidc/:identityId/refresh: failure", () => {
  it("image server 500 -> 422 avatar_fetch_failed; neither message nor log contains the URL (with token); no candidate, no file; avatar_auto and picture_dismissed_url unchanged", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY }, { logger });
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(db);
    const picture = `${img.base}/a.png?token=sekret-token`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("avatar_fetch_failed");
    expect(res.body).not.toContain("sekret-token");
    expect(res.body).not.toContain("127.0.0.1");
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
    expect(await autoOf(db, alice.id)).toBe(true);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBe(picture);
    const logged = out.join("");
    expect(logged).not.toContain("sekret-token");
    expect(logged).toContain("http_status");
  });

  it("production address policy (not injected) -> a URL pointing at loopback gives 422 avatar_fetch_failed and no request is sent", async () => {
    const { app, db } = await buildTestApp();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("avatar_fetch_failed");
    expect(img.requests()).toBe(0);
  });

  it("space full -> 409 storage_quota_exceeded, no download (request count 0)", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    await db.insert(userAvatars).values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 1000, displayData: Buffer.alloc(10, 0x41), displayMime: "image/webp", displaySize: 10 });
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("storage_quota_exceeded");
    expect(img.requests()).toBe(0);
  });

  it("doesn't fit -> 409 storage_quota_exceeded; whole request rolled back: no candidate, no file, avatar_auto and picture_dismissed_url unchanged", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 400);
    const picture = `${img.base}/a.png`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("storage_quota_exceeded");
    expect(img.requests()).toBe(1);
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
    expect(await autoOf(db, alice.id)).toBe(true);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBe(picture);
  });

  it("unlinked during download -> 404; no candidate, no leftover file", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const pending = refresh(app, alice.id, identityId);
    await img.arrived();
    await db.delete(userIdentities).where(eq(userIdentities.id, identityId));
    release();
    const res = await pending;
    expect(res.statusCode, res.body).toBe(404);
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
  });
});

describe("POST /api/auth/avatars/oidc/:identityId/refresh: identity check, throttling, authentication", () => {
  it("someone else's identity, last_picture_url NULL, not a UUID -> 404 and no bucket charge (limit 1: after three 404s the first real request is still 200)", async () => {
    const { app, db } = await buildTestApp(
      { avatarFetchPolicy: OPEN_POLICY, limiters: { avatarRefresh: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } },
    );
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: `${img.base}/a.png` });
    const noPicture = await seedIdentity(db, alice.id, { lastPictureUrl: null });
    const own = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    for (const id of [bobIdentity, noPicture, "not-a-uuid"]) {
      const res = await refresh(app, alice.id, id);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(404);
    }
    expect(img.requests()).toBe(0);
    expect(await rowsOf(db, bob.id)).toEqual([]);
    expect((await refresh(app, alice.id, own)).statusCode).toBe(200);
  });

  it("per-person hourly limit: the 2nd gets 429 (with limit 1); bob has his own quota; the blocked request doesn't download", async () => {
    const { app, db } = await buildTestApp(
      { avatarFetchPolicy: OPEN_POLICY, limiters: { avatarRefresh: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } },
    );
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const aliceIdentity = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: `${img.base}/a.png` });
    expect((await refresh(app, alice.id, aliceIdentity)).statusCode).toBe(200);
    expect(img.requests()).toBe(1);
    const limited = await refresh(app, alice.id, aliceIdentity);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.code).toBe("too_many_requests");
    expect(img.requests()).toBe(1);
    expect((await refresh(app, bob.id, bobIdentity)).statusCode).toBe(200);
  });

  it("default bucket is 10 per person per hour: the 11th gets 429", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    for (let i = 0; i < 10; i++) expect((await refresh(app, alice.id, identityId)).statusCode).toBe(422);
    expect((await refresh(app, alice.id, identityId)).statusCode).toBe(429);
  });

  it("not signed in 401; Bearer (personal token) is also 401", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    expect((await refresh(app, null, identityId)).statusCode).toBe(401);
    const { token } = await seedTokenForUser(db, alice.id);
    expect((await refresh(app, null, identityId, bearer(token))).statusCode).toBe(401);
    expect(img.requests()).toBe(0);
    expect(await db.select().from(userAvatars).where(and(eq(userAvatars.userId, alice.id)))).toEqual([]);
  });
});
