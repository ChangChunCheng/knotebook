/** The image server is a local `node:http` and the download policy is injected to allow loopback and any port; URLs and bytes are made by the test itself. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarFetchPolicy } from "../src/avatars/oidc-fetch.js";
import { runOidcAvatarJob, scheduleOidcAvatarJob, type OidcAvatarJobDeps, type OidcAvatarJobResult } from "../src/avatars/oidc-job.js";
import { AvatarIdentityGone, replaceOidcAvatarInTx } from "../src/avatars/tx/avatars.js";
import type { Db } from "../src/db/index.js";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { StorageQuotaExceeded } from "../src/storage/tx/quota.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";

const ISSUER = "https://idp.example";
const OPEN_POLICY: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };

/** A PNG whose content is determined by `fill` (same signature, different bytes -> different sha256). */
function pngFilled(size: number, fill: number): Buffer {
  const b = pngOf(size);
  b.fill(fill, 8);
  return b;
}

interface ImageRoute {
  status?: number;
  body?: Buffer;
  /** After the request arrives, the response waits for this Promise. */
  hold?: Promise<void>;
}

interface ImageServer {
  base: string;
  requests: () => number;
  /** Resolves when the n-th request (counting from 1) arrives. */
  arrived: (n: number) => Promise<void>;
  setRoute: (p: string, r: ImageRoute) => void;
  close: () => Promise<void>;
}

async function imageServer(initial: Record<string, ImageRoute> = {}): Promise<ImageServer> {
  const routes = new Map<string, ImageRoute>(Object.entries(initial));
  let count = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    count++;
    for (const w of waiters.filter(w => w.n <= count)) w.resolve();
    const route = routes.get((req.url ?? "").split("?")[0]!);
    void (async () => {
      if (route?.hold) await route.hold;
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const status = route.status ?? 200;
      res.writeHead(status, { "content-type": "image/png" });
      res.end(route.body ?? Buffer.alloc(0));
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return {
    base: `http://127.0.0.1:${port}`,
    requests: () => count,
    arrived: n => (count >= n ? Promise.resolve() : new Promise<void>(resolve => waiters.push({ n, resolve }))),
    setRoute: (p, r) => void routes.set(p, r),
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

async function seedIdentity(db: Db, userId: string, over: { dismissed?: string } = {}): Promise<{ id: string; sub: string }> {
  const sub = `sub-${randomUUID()}`;
  const [row] = await db
    .insert(userIdentities)
    .values({ userId, issuer: ISSUER, sub, ...(over.dismissed !== undefined ? { pictureDismissedUrl: over.dismissed } : {}) })
    .returning({ id: userIdentities.id });
  return { id: row!.id, sub };
}

interface Harness {
  db: Db;
  uploadsDir: string;
  deps: OidcAvatarJobDeps;
  settled: OidcAvatarJobResult[];
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
  invalidated: string[];
}

async function harness(over: Partial<OidcAvatarJobDeps> = {}): Promise<Harness> {
  const { db, uploadsDir } = await buildTestApp();
  const settled: OidcAvatarJobResult[] = [];
  const logs: Harness["logs"] = [];
  const invalidated: string[] = [];
  const deps: OidcAvatarJobDeps = {
    db,
    gate: { invalidate: (id: string) => void invalidated.push(id) },
    uploadsDir,
    storageLockTimeoutMs: 5000,
    avatarFetchPolicy: OPEN_POLICY,
    avatarJobHooks: { onSettled: r => void settled.push(r) },
    log: { info: (obj, msg) => void logs.push({ obj: obj as Record<string, unknown>, msg }) },
    ...over,
  };
  return { db, uploadsDir, deps, settled, logs, invalidated };
}

const rowsOf = (db: Db, userId: string) => db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
const identityOf = async (db: Db, id: string) => (await db.select().from(userIdentities).where(eq(userIdentities.id, id)))[0]!;
const filesOf = async (dir: string) => (await readdir(dir)).sort();

/** Fills a candidate with display image and crop (simulates the browser having generated it, or the user having cropped). */
async function giveDisplay(db: Db, id: string): Promise<void> {
  await db
    .update(userAvatars)
    .set({ cropX: 1, cropY: 2, cropSize: 30, originalWidth: 40, originalHeight: 50, displayData: Buffer.alloc(120, 0x41), displayMime: "image/webp", displaySize: 120 })
    .where(eq(userAvatars.id, id));
}

describe("runOidcAvatarJob: creation and auto-select", () => {
  it("no candidate, avatar_auto = true, no current avatar -> creates an OIDC candidate and selects it; avatar_auto stays true; display image NULL; last_picture_url written", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "oidc", identityId: idn.id, oidcPictureUrl: picture, isCurrent: true, displayData: null, displayMime: null, displaySize: 0, originalSize: 500, originalMime: "image/png", version: 1 });
    expect(rows[0]!.cropX).toBeNull();
    expect(rows[0]!.originalWidth).toBeNull();
    expect(existsSync(path.join(h.uploadsDir, rows[0]!.originalFile))).toBe(true);
    const [u] = await h.db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(u!.avatarAuto).toBe(true);
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(picture);
    expect(h.settled).toEqual([expect.objectContaining({ outcome: "inserted" })]);
    expect(h.invalidated).toEqual([alice.id]);
  });

  it("already has a current avatar (uploaded) -> the OIDC candidate is created but is not the current avatar", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const [up] = await h.db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning({ id: userAvatars.id });
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.source === "oidc")!.isCurrent).toBe(false);
    expect(rows.find(r => r.id === up!.id)!.isCurrent).toBe(true);
  });

  it("avatar_auto = false and no current avatar -> not auto-selected", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    await h.db.update(users).set({ avatarAuto: false }).where(eq(users.id, alice.id));
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCurrent).toBe(false);
    const [u] = await h.db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(u!.avatarAuto).toBe(false);
  });
});

describe("runOidcAvatarJob: same URL, changed URL", () => {
  it("same URL -> no download (request count doesn't grow)", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` };
    await runOidcAvatarJob(h.deps, args);
    expect(img.requests()).toBe(1);
    await runOidcAvatarJob(h.deps, args);
    expect(img.requests()).toBe(1);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "same_url" });
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
  });

  it("changed URL, different bytes -> replaced in place: same id, version+1, crop and display image cleared, old file deleted, new file present, is_current unchanged, usage delta correct; bob unaffected", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) }, "/b.png": { body: pngFilled(700, 2) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const aIdn = await seedIdentity(h.db, alice.id);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/a.png` });
    await runOidcAvatarJob(h.deps, { userId: bob.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    const [before] = await rowsOf(h.db, alice.id);
    await giveDisplay(h.db, before!.id);
    const [bobBefore] = await rowsOf(h.db, bob.id);
    await giveDisplay(h.db, bobBefore!.id);
    const bobSnapshot = (await rowsOf(h.db, bob.id))[0]!;
    expect((await readSpaceUsage(h.db, { kind: "user", id: alice.id }))!.usedBytes).toBe(500 + 120);

    const second = `${img.base}/b.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: second });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    expect(after).toMatchObject({ id: before!.id, version: 2, isCurrent: true, oidcPictureUrl: second, originalSize: 700, displayData: null, displayMime: null, displaySize: 0, cropX: null, cropY: null, cropSize: null, originalWidth: null, originalHeight: null });
    expect(after.originalFile).not.toBe(before!.originalFile);
    expect(existsSync(path.join(h.uploadsDir, before!.originalFile))).toBe(false);
    expect(existsSync(path.join(h.uploadsDir, after.originalFile))).toBe(true);
    expect((await readSpaceUsage(h.db, { kind: "user", id: alice.id }))!.usedBytes).toBe(700);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "replaced" });
    expect((await rowsOf(h.db, bob.id))[0]).toEqual(bobSnapshot);
    expect(existsSync(path.join(h.uploadsDir, bobSnapshot.originalFile))).toBe(true);
  });

  it("changed URL, same bytes -> only oidc_picture_url changes; crop and display image kept, version unchanged, no extra files; bob unaffected", async () => {
    const h = await harness();
    const same = pngFilled(500, 1);
    const img = await imageServer({ "/a.png": { body: same }, "/copy.png": { body: Buffer.from(same) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const aIdn = await seedIdentity(h.db, alice.id);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/a.png` });
    await runOidcAvatarJob(h.deps, { userId: bob.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    const [before] = await rowsOf(h.db, alice.id);
    await giveDisplay(h.db, before!.id);
    const bobSnapshot = (await rowsOf(h.db, bob.id))[0]!;
    const filesBefore = await filesOf(h.uploadsDir);

    const second = `${img.base}/copy.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: second });
    const [after] = await rowsOf(h.db, alice.id);
    expect(after).toMatchObject({ id: before!.id, version: 1, oidcPictureUrl: second, originalFile: before!.originalFile, cropX: 1, cropSize: 30, displaySize: 120, originalWidth: 40 });
    expect(after!.displayData?.length).toBe(120);
    expect(await filesOf(h.uploadsDir)).toEqual(filesBefore);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "same_bytes" });
    expect((await rowsOf(h.db, bob.id))[0]).toEqual(bobSnapshot);
  });
});

describe("runOidcAvatarJob: failure and removed", () => {
  it("image server 500 -> no candidate, no file, last_picture_url still written; after the server recovers, running again with the same URL -> created", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture };
    await runOidcAvatarJob(h.deps, args);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(picture);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "http_status" });
    expect(h.invalidated).toEqual([]);
    img.setRoute("/a.png", { body: pngFilled(500, 1) });
    await runOidcAvatarJob(h.deps, args);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
  });

  it("picture equals picture_dismissed_url -> no download; a new URL -> downloaded and created; bob's same-shaped data unaffected", async () => {
    const h = await harness();
    const img = await imageServer({ "/old.png": { body: pngFilled(500, 1) }, "/new.png": { body: pngFilled(600, 2) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const oldUrl = `${img.base}/old.png`;
    const aIdn = await seedIdentity(h.db, alice.id, { dismissed: oldUrl });
    const bIdn = await seedIdentity(h.db, bob.id, { dismissed: oldUrl });
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: oldUrl });
    expect(img.requests()).toBe(0);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "dismissed" });
    expect((await identityOf(h.db, aIdn.id)).lastPictureUrl).toBe(oldUrl);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/new.png` });
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
    expect(img.requests()).toBe(1);
    expect((await identityOf(h.db, bIdn.id)).lastPictureUrl).toBeNull();
    expect((await identityOf(h.db, bIdn.id)).pictureDismissedUrl).toBe(oldUrl);
    expect(await rowsOf(h.db, bob.id)).toHaveLength(0);
  });

  it("the user dismissed the same URL during download (picture_dismissed_url set) -> not inserted, the new file cleaned up, reason is dismissed", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    const deps: OidcAvatarJobDeps = {
      ...h.deps,
      avatarTestHooks: { afterUserLock: async () => void (await h.db.update(userIdentities).set({ pictureDismissedUrl: picture }).where(eq(userIdentities.id, idn.id))) },
    };
    await runOidcAvatarJob(deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "dismissed" });
    expect(h.invalidated).toEqual([]);
  });

  it("no picture -> no download, last_picture_url cleared to NULL", async () => {
    const h = await harness();
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    await h.db.update(userIdentities).set({ lastPictureUrl: "https://img.example/x.png" }).where(eq(userIdentities.id, idn.id));
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: null });
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBeNull();
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "no_picture" });
  });

  it("identity row doesn't exist (or doesn't belong to this person) -> ends, no download", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "no_identity" });
  });

  it("unlinked during download -> no candidate, no leftover file, reason is unlinked", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const running = runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    await img.arrived(1);
    await h.db.delete(userIdentities).where(eq(userIdentities.id, idn.id));
    release();
    await running;
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "unlinked" });
  });
});

describe("runOidcAvatarJob: quota", () => {
  it("not enough remaining -> no candidate, no file, reason = quota", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(2000, 1) } });
    const alice = await seedUser(h.db);
    await giveUserQuota(h.db, alice.id, 1000);
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "quota" });
    expect(h.logs.at(-1)!.obj).toMatchObject({ reason: "quota" });
  });

  it("full -> no download (request count 0), reason = quota", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(200, 1) } });
    const alice = await seedUser(h.db);
    await giveUserQuota(h.db, alice.id, 300);
    await h.db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 250, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50 });
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "quota" });
  });
});

describe("runOidcAvatarJob: dedup and logging", () => {
  it("same user and same identity queued twice with the server holding -> only one request; the later one is skipped", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` };
    const first = runOidcAvatarJob(h.deps, args);
    await img.arrived(1);
    const second = await runOidcAvatarJob(h.deps, args);
    expect(second).toMatchObject({ outcome: "skipped", reason: "in_flight" });
    release();
    expect(await first).toMatchObject({ outcome: "inserted" });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
    // The key is released after it finishes: a different URL can run again
    img.setRoute("/b.png", { body: pngFilled(600, 2) });
    expect(await runOidcAvatarJob(h.deps, { ...args, picture: `${img.base}/b.png` })).toMatchObject({ outcome: "replaced" });
  });

  it("another one arriving while one is in progress (with a changed URL) -> the later one is skipped, but last_picture_url is the later value", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold }, "/b.png": { body: pngFilled(600, 2) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const first = runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    await img.arrived(1);
    const second = `${img.base}/b.png`;
    expect(await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: second })).toMatchObject({ outcome: "skipped", reason: "in_flight" });
    release();
    await first;
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(second);
  });

  it("on failure one info line with userId, identityId, reason; no URL string (a query carrying a token doesn't appear)", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png?token=secretvalue`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.obj).toEqual({ userId: alice.id, identityId: idn.id, reason: "http_status" });
    const text = JSON.stringify(h.logs) + JSON.stringify(h.settled);
    expect(text).not.toContain("secretvalue");
    expect(text).not.toContain("127.0.0.1");
  });

  it("a database error logs only name and code, not the original error", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    // Use the transaction's test hook to throw an error carrying params (simulates drizzle putting SQL params in the message).
    const boom = Object.assign(new Error(`insert into "user_avatars" params: secretvalue`), { code: "XX000" });
    const deps: OidcAvatarJobDeps = { ...h.deps, avatarTestHooks: { afterUserLock: () => Promise.reject(boom) } };
    await runOidcAvatarJob(deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "error" });
    expect(h.logs.at(-1)!.obj).toEqual({ userId: alice.id, identityId: idn.id, reason: "error", name: "Error", code: "XX000" });
    expect(JSON.stringify(h.logs)).not.toContain("secretvalue");
    expect(await filesOf(h.uploadsDir)).toEqual([]);
  });
});

describe("scheduleOidcAvatarJob", () => {
  it("returns synchronously (doesn't wait for the download); onSettled is called after the background run finishes", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const done = new Promise<OidcAvatarJobResult>(resolve => {
      h.deps.avatarJobHooks = { onSettled: resolve };
    });
    const ret = scheduleOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(ret).toBeUndefined();
    expect(img.requests()).toBe(0);
    await img.arrived(1);
    release();
    expect(await done).toMatchObject({ outcome: "inserted" });
  });

  it("an error thrown by run doesn't leak as an unhandled rejection", async () => {
    const h = await harness();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const done = new Promise<void>(resolve => {
        h.deps.avatarJobHooks = {
          onSettled: () => {
            resolve();
            throw new Error("hook exploded");
          },
        };
      });
      scheduleOidcAvatarJob(h.deps, { userId: randomUUID(), issuer: ISSUER, sub: "nobody", picture: null });
      await done;
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("replaceOidcAvatarInTx", () => {
  const lockTimeoutMs = 5000;
  const input = (userId: string, identityId: string, size: number, fill: number, url = "https://img.example/a.png") => ({
    userId,
    identityId,
    oidcPictureUrl: url,
    originalFile: randomUUID(),
    originalSha256: Buffer.alloc(32, fill),
    originalMime: "image/png",
    originalSize: size,
    lockTimeoutMs,
  });

  it("no candidate found -> inserted (auto-select condition same as insertion)", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    const r = await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 100, 1)));
    expect(r.outcome).toBe("inserted");
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isCurrent: true, identityId: idn.id });
  });

  it("identity row isn't this person's -> AvatarIdentityGone, no row left", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bIdn = await seedIdentity(db, bob.id);
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, bIdn.id, 100, 1)))).rejects.toBeInstanceOf(AvatarIdentityGone);
    expect(await rowsOf(db, alice.id)).toHaveLength(0);
    expect(await rowsOf(db, bob.id)).toHaveLength(0);
  });

  it("different bytes: returns the old file name; original grows and space isn't enough -> StorageQuotaExceeded and row unchanged", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    const first = input(alice.id, idn.id, 400, 1);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, first));
    await giveUserQuota(db, alice.id, 500);
    const bigger = input(alice.id, idn.id, 900, 2);
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, bigger))).rejects.toBeInstanceOf(StorageQuotaExceeded);
    expect((await rowsOf(db, alice.id))[0]).toMatchObject({ originalFile: first.originalFile, originalSize: 400, version: 1 });
    const smaller = input(alice.id, idn.id, 300, 3);
    const r = await db.transaction(tx => replaceOidcAvatarInTx(tx, smaller));
    expect(r).toEqual({ outcome: "replaced", oldFile: first.originalFile });
    expect((await rowsOf(db, alice.id))[0]).toMatchObject({ originalFile: smaller.originalFile, originalSize: 300, version: 2 });
  });

  it("the replacement quota delta includes the old display image: old original 400 + old display 120, new original 500, quota 600 -> allowed (delta -20); then with usage 500 (quota 600), new original 700 -> rejected", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 400, 1)));
    await giveDisplay(db, (await rowsOf(db, alice.id))[0]!.id);
    await giveUserQuota(db, alice.id, 600);
    const ok = await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 500, 2)));
    expect(ok.outcome).toBe("replaced");
    expect((await readSpaceUsage(db, { kind: "user", id: alice.id }))!.usedBytes).toBe(500);
    // usage 500, quota 600: new original 700 -> delta +200, 500+200 > 600
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 700, 3)))).rejects.toBeInstanceOf(StorageQuotaExceeded);
  });

  it("every UPDATE statement is scoped to user_id/identity_id: unaffected when bob has a same-shaped candidate", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const aIdn = await seedIdentity(db, alice.id);
    const bIdn = await seedIdentity(db, bob.id);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, aIdn.id, 100, 1)));
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(bob.id, bIdn.id, 100, 1)));
    const bobBefore = (await rowsOf(db, bob.id))[0]!;
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, aIdn.id, 200, 2, "https://img.example/b.png")));
    expect((await rowsOf(db, bob.id))[0]).toEqual(bobBefore);
    const [other] = await db.select({ n: userAvatars.version }).from(userAvatars).where(and(eq(userAvatars.userId, bob.id), eq(userAvatars.identityId, bIdn.id)));
    expect(other!.n).toBe(1);
  });
});
