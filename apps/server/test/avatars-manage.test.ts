/** Concurrency cases use `avatarTestHooks.afterUserLock` to hold the first request right after it takes the users row lock. */
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";
import { DEFAULT_CROP, recropAvatar, seedAvatarRow, uploadAvatar, webpOf } from "./avatar-helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

const rowsOf = async (db: Ctx["db"], userId: string) =>
  db.select().from(userAvatars).where(eq(userAvatars.userId, userId)).orderBy(asc(userAvatars.createdAt), asc(userAvatars.id));

const rowOf = async (db: Ctx["db"], id: string) => {
  const [row] = await db.select().from(userAvatars).where(eq(userAvatars.id, id));
  return row;
};

const usedBytes = async (db: Ctx["db"], userId: string): Promise<number> => (await readSpaceUsage(db, { kind: "user", id: userId }))!.usedBytes;

const select = async (app: Ctx["app"], userId: string, body: unknown) =>
  app.inject({ method: "PUT", url: "/api/auth/avatar", payload: body as object, cookies: await cookieOf(userId) });

const remove = async (app: Ctx["app"], userId: string, id: string) =>
  app.inject({ method: "DELETE", url: `/api/auth/avatars/${id}`, cookies: await cookieOf(userId) });

const readOriginal = async (app: Ctx["app"], userId: string, id: string) =>
  app.inject({ method: "GET", url: `/api/auth/avatars/${id}/original`, cookies: await cookieOf(userId) });

async function uploaded(app: Ctx["app"], userId: string, opts: Parameters<typeof uploadAvatar>[2] = {}): Promise<string> {
  const res = await uploadAvatar(app, userId, opts);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const NEW_CROP = { x: 1, y: 2, size: 30, width: 200, height: 150 };

function logCollector() {
  const out: string[] = [];
  return { out, logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } };
}

const levels = (out: string[]): number[] => out.map(line => (JSON.parse(line) as { level: number }).level);

describe("PUT /api/auth/avatars/:id/display: re-crop", () => {
  it("200 returns the updated candidate; version + 1, crop, original width/height and display image all replaced; original file and current-avatar flag untouched; /me is immediately the new version", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toEqual({ id, v: 1, pending: false });

    const display = webpOf(500);
    const res = await recropAvatar(app, alice.id, id, { display, crop: NEW_CROP, version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      avatar: { id, v: 2 },
      pending: false,
      current: true,
      crop: { x: 1, y: 2, size: 30 },
      originalWidth: 200,
      originalHeight: 150,
      originalSize: before.originalSize,
      displaySize: 500,
    });
    const after = (await rowOf(db, id))!;
    expect(after).toMatchObject({ version: 2, cropX: 1, cropY: 2, cropSize: 30, originalWidth: 200, originalHeight: 150, displaySize: 500, displayMime: "image/webp", isCurrent: true });
    expect(Buffer.compare(after.displayData!, display)).toBe(0);
    expect(after.originalFile).toBe(before.originalFile);
    expect(await readdir(uploadsDir)).toEqual([before.originalFile]);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toEqual({ id, v: 2, pending: false });
  });

  it("an OIDC candidate with a pending display image can also be filled in: pending becomes false, usage gains the whole display image", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 700, displaySize: 0 });
    expect(await usedBytes(db, alice.id)).toBe(700);
    const res = await recropAvatar(app, alice.id, id, { display: webpOf(400), crop: NEW_CROP, version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: "oidc", pending: false, displaySize: 400, avatar: { id, v: 2 } });
    expect(await usedBytes(db, alice.id)).toBe(1100);
  });

  it("usage counts only the difference: shrinking always succeeds (even with the quota full); growing beyond the remaining space -> 409 and DB unchanged; exactly fitting -> 200", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id, { original: pngOf(2000), display: webpOf(300) });
    await giveUserQuota(db, alice.id, 2300);
    expect(await usedBytes(db, alice.id)).toBe(2300);

    const grow = await recropAvatar(app, alice.id, id, { display: webpOf(301), version: 1 });
    expect(grow.statusCode, grow.body).toBe(409);
    expect(grow.json().error.code).toBe("storage_quota_exceeded");
    expect(grow.json().storage).toEqual({ incomingBytes: 1, usedBytes: 2300, quotaBytes: 2300 });
    expect(await rowOf(db, id)).toMatchObject({ version: 1, displaySize: 300 });

    const shrink = await recropAvatar(app, alice.id, id, { display: webpOf(100), version: 1 });
    expect(shrink.statusCode, shrink.body).toBe(200);
    expect(await usedBytes(db, alice.id)).toBe(2100);

    const fits = await recropAvatar(app, alice.id, id, { display: webpOf(300), version: 2 });
    expect(fits.statusCode, fits.body).toBe(200);
    const over = await recropAvatar(app, alice.id, id, { display: webpOf(301), version: 3 });
    expect(over.statusCode).toBe(409);
    expect(over.json().storage.incomingBytes).toBe(1);
    expect(await rowOf(db, id)).toMatchObject({ version: 3, displaySize: 300 });
  });

  it("version mismatch -> 409 avatar_outdated, DB unchanged; version missing, not a positive integer or above int4 -> 400", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;

    const stale = await recropAvatar(app, alice.id, id, { display: webpOf(500), crop: NEW_CROP, version: 2 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("avatar_outdated");
    const after = (await rowOf(db, id))!;
    expect(after.version).toBe(1);
    expect(after.displaySize).toBe(before.displaySize);
    expect(Buffer.compare(after.displayData!, before.displayData!)).toBe(0);
    expect(after.cropX).toBe(before.cropX);

    for (const [label, version] of [["缺", null], ["0", 0], ["負數", -1], ["小數", "1.5"], ["字串", "abc"], ["超過 int4", "2147483648"], ["前導零", "01"]] as const) {
      const res = await recropAvatar(app, alice.id, id, { version });
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(res.json().error.code, label).toBe("invalid_body");
    }
    expect((await rowOf(db, id))!.version).toBe(1);
  });

  it("format validation same as upload: missing display/crop, bad crop or width above int4 -> 400; GIF or text as the display image -> 415; display image too large -> 413; DB untouched in all cases", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const bad: Array<[string, Parameters<typeof recropAvatar>[3], number]> = [
      ["缺 display", { display: null }, 400],
      ["缺 crop", { crop: null }, 400],
      ["crop 越界", { crop: { ...DEFAULT_CROP, x: DEFAULT_CROP.width } }, 400],
      ["crop 不是 JSON", { crop: "nope" }, 400],
      ["寬度超過 int4 上限", { crop: { x: 0, y: 0, size: 10, width: 2 ** 31, height: 100 } }, 400],
      ["GIF 顯示圖", { display: Buffer.from("GIF89a-not-an-avatar") }, 415],
      ["文字當顯示圖", { display: Buffer.from("just text, not an image at all") }, 415],
      ["顯示圖過大", { display: webpOf(262_145) }, 413],
      ["顯示圖遠大於上限但小於站台上傳上限", { display: webpOf(1_000_000) }, 413],
    ];
    for (const [label, opts, status] of bad) {
      const res = await recropAvatar(app, alice.id, id, opts);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(status);
    }
    const after = (await rowOf(db, id))!;
    expect(after.version).toBe(before.version);
    expect(Buffer.compare(after.displayData!, before.displayData!)).toBe(0);
  });
});

describe("ownership of avatar candidate ids: someone else's, nonexistent and malformed ids all give the same 404", () => {
  it("re-crop, delete, read original: bob's candidate, a nonexistent uuid and not-a-uuid give a byte-identical 404; bob's row and file are untouched", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsId = await uploaded(app, bob.id);
    const bobsBefore = (await rowOf(db, bobsId))!;
    const ghost = "00000000-0000-4000-8000-000000000000";

    const run = {
      recrop: (id: string) => recropAvatar(app, alice.id, id, { display: webpOf(500), crop: NEW_CROP, version: 1 }),
      remove: (id: string) => remove(app, alice.id, id),
      original: (id: string) => readOriginal(app, alice.id, id),
    };
    for (const [name, fn] of Object.entries(run)) {
      const others = await fn(bobsId);
      const missing = await fn(ghost);
      const malformed = await fn("not-a-uuid");
      expect(others.statusCode, name).toBe(404);
      expect(others.json().error.code, name).toBe("not_found");
      expect(missing.body, name).toBe(others.body);
      expect(malformed.body, name).toBe(others.body);
      expect(missing.statusCode, name).toBe(404);
      expect(malformed.statusCode, name).toBe(404);
    }
    // A version mismatch must not reveal someone else's candidate as 409: ownership is checked before version.
    const staleOthers = await recropAvatar(app, alice.id, bobsId, { display: webpOf(500), crop: NEW_CROP, version: 7 });
    const staleMissing = await recropAvatar(app, alice.id, ghost, { display: webpOf(500), crop: NEW_CROP, version: 7 });
    expect(staleOthers.statusCode).toBe(404);
    expect(staleOthers.body).toBe(staleMissing.body);
    const bobsAfter = (await rowOf(db, bobsId))!;
    expect(bobsAfter).toEqual(bobsBefore);
    expect(await readdir(uploadsDir)).toEqual([bobsBefore.originalFile]);
  });

  it("uppercase uuid works (re-crop, read original, delete)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const upper = id.toUpperCase();
    expect((await readOriginal(app, alice.id, upper)).statusCode).toBe(200);
    expect((await recropAvatar(app, alice.id, upper, { version: 1 })).statusCode).toBe(200);
    expect((await remove(app, alice.id, upper)).statusCode).toBe(204);
    expect(await rowsOf(db, alice.id)).toEqual([]);
  });
});

describe("PUT /api/auth/avatar: select", () => {
  it("200 returns the new UserDto (not the cache from 60 seconds ago); target is the current avatar and the old one isn't; avatar_auto turned off", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsAvatar = await uploaded(app, bob.id);
    const first = await uploaded(app, alice.id);
    const second = await uploaded(app, alice.id, { original: pngOf(2500) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(second);

    const res = await select(app, alice.id, { candidateId: first });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().id).toBe(alice.id);
    expect(res.json().avatar).toEqual({ id: first, v: 1, pending: false });
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[first, true], [second, false]]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(first);

    const again = await select(app, alice.id, { candidateId: first.toUpperCase() });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().avatar.id).toBe(first);
    expect((await rowOf(db, bobsAvatar))!.isCurrent).toBe(true);
  });

  it("candidateId null -> avatar null, candidates all remain, none is current; avatar_auto turned off", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsAvatar = await uploaded(app, bob.id);
    await uploaded(app, alice.id);
    await uploaded(app, alice.id, { original: pngOf(2500) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const res = await select(app, alice.id, { candidateId: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().avatar).toBeNull();
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isCurrent)).toEqual([]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
    expect((await rowOf(db, bobsAvatar))!.isCurrent).toBe(true);
  });

  it("selecting bob's candidate or a nonexistent id -> 404, alice's current avatar and avatar_auto are both unchanged (whole request rolled back)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const mine = await uploaded(app, alice.id);
    const bobsId = await uploaded(app, bob.id);
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));

    for (const target of [bobsId, "00000000-0000-4000-8000-000000000000"]) {
      const res = await select(app, alice.id, { candidateId: target });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[mine, true]]);
    expect((await rowOf(db, bobsId))!.isCurrent).toBe(true);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);
  });

  it("invalid body -> 400 invalid_body (missing field, non-uuid, extra field, non-object)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const mine = await uploaded(app, alice.id);
    for (const body of [{}, { candidateId: "x" }, { candidateId: 5 }, { candidateId: mine, extra: 1 }, [mine]]) {
      const res = await select(app, alice.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect((await rowOf(db, mine))!.isCurrent).toBe(true);
  });
});

describe("DELETE /api/auth/avatars/:id: delete", () => {
  it("deleting a non-current candidate: 204; row and original file are gone; usage drops by original + display; avatar_auto unchanged; current avatar untouched", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const old = await uploaded(app, alice.id, { original: pngOf(1000), display: webpOf(200) });
    const current = await uploaded(app, alice.id, { original: pngOf(2000), display: webpOf(300) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const oldFile = (await rowOf(db, old))!.originalFile;
    const currentFile = (await rowOf(db, current))!.originalFile;
    expect(await usedBytes(db, alice.id)).toBe(3500);

    const res = await remove(app, alice.id, old);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect(await rowOf(db, old)).toBeUndefined();
    expect(await readdir(uploadsDir)).toEqual([currentFile]);
    expect(oldFile).not.toBe(currentFile);
    expect(await usedBytes(db, alice.id)).toBe(2300);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);
    expect((await rowOf(db, current))!.isCurrent).toBe(true);
  });

  it("deleting the current one: afterwards avatar is null, avatar_auto is off, other candidates aren't auto-selected; /me reflects it immediately", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const a = await uploaded(app, alice.id);
    const b = await uploaded(app, alice.id, { original: pngOf(2200) });
    const c = await uploaded(app, alice.id, { original: pngOf(2400) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(c);

    expect((await remove(app, alice.id, c)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toBeNull();
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[a, false], [b, false]]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
  });

  it("deleting an OIDC candidate: that identity's picture_dismissed_url records the row's picture URL; bob's identity row and candidate unchanged; also leaves others' rows alone when the candidate points at someone else's identity row", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const identity = async (userId: string) => {
      const [row] = await db.insert(userIdentities).values({ userId, issuer: "https://sso.example", sub: `sub-${Math.random()}`, lastPictureUrl: "https://pics.example/x.png" }).returning({ id: userIdentities.id });
      return row!.id;
    };
    const aliceIdentity = await identity(alice.id);
    const bobIdentity = await identity(bob.id);
    const mine = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0, identityId: aliceIdentity });
    const bobsCandidate = await seedAvatarRow(db, { userId: bob.id, originalSize: 80, displaySize: 0, identityId: bobIdentity });
    const dismissedOf = async (id: string) => (await db.select({ u: userIdentities.pictureDismissedUrl }).from(userIdentities).where(eq(userIdentities.id, id)))[0]!.u;
    const urlOf = async (id: string) => (await rowOf(db, id))!.oidcPictureUrl;
    const expected = await urlOf(mine);
    expect(expected).toMatch(/^https:\/\/idp\.example\.com\/pic\//);

    expect((await remove(app, alice.id, mine)).statusCode).toBe(204);
    expect(await dismissedOf(aliceIdentity)).toBe(expected);
    expect(await dismissedOf(bobIdentity)).toBeNull();
    expect(await rowOf(db, bobsCandidate)).toBeDefined();

    // Data that shouldn't exist: alice's candidate hanging on bob's identity; deleting it must not touch bob's identity row.
    // One identity has at most one candidate (partial unique index): bob's candidate has to be removed before this one can be placed.
    await db.delete(userAvatars).where(eq(userAvatars.id, bobsCandidate));
    const strayId = await seedAvatarRow(db, { userId: alice.id, originalSize: 90, displaySize: 0, identityId: bobIdentity });
    expect((await remove(app, alice.id, strayId)).statusCode).toBe(204);
    expect(await dismissedOf(bobIdentity)).toBeNull();
  });

  it("deleting an upload-source candidate doesn't touch any identity row", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const [ident] = await db.insert(userIdentities).values({ userId: alice.id, issuer: "https://sso.example", sub: "s1", lastPictureUrl: "https://pics.example/y.png" }).returning({ id: userIdentities.id });
    const id = await uploaded(app, alice.id);
    expect((await remove(app, alice.id, id)).statusCode).toBe(204);
    const [row] = await db.select({ u: userIdentities.pictureDismissedUrl }).from(userIdentities).where(eq(userIdentities.id, ident!.id));
    expect(row!.u).toBeNull();
  });

  it("after the file is gone from disk, deletion still gives 204 and the log has only a warn (no error)", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({}, { logger });
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const file = (await rowOf(db, id))!.originalFile;
    await rm(path.join(uploadsDir, file));
    out.length = 0;

    const res = await remove(app, alice.id, id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await rowOf(db, id)).toBeUndefined();
    const seen = levels(out.filter(line => line.includes(file)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(l => l === 40)).toBe(true);
    expect(levels(out).filter(l => l >= 50)).toEqual([]);
    await app.close();
  });
});

describe("GET /api/auth/avatars/:id/original: owner reads the original", () => {
  it("200, bytes equal; content-type is the stored detected value, plus nosniff, CSP sandbox, private no-cache", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const original = pngOf(1800);
    const id = await uploaded(app, alice.id, { original });
    const res = await readOriginal(app, alice.id, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(Buffer.compare(res.rawPayload, original)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });

  it("bob reading alice's original -> 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const id = await uploaded(app, alice.id);
    expect((await readOriginal(app, bob.id, id)).statusCode).toBe(404);
  });

  it("row exists, file missing from disk -> 404, log records one warn (without the file path)", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({}, { logger });
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const file = (await rowOf(db, id))!.originalFile;
    await rm(path.join(uploadsDir, file));
    out.length = 0;
    const res = await readOriginal(app, alice.id, id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    const warns = out.filter(line => (JSON.parse(line) as { level: number }).level === 40);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some(line => line.includes(uploadsDir.replaceAll("\\", "\\\\")) || line.includes(uploadsDir))).toBe(false);
    await app.close();
  });

  it("OIDC candidate whose display image isn't generated yet and original file missing too -> 404 (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    expect((await readOriginal(app, alice.id, id)).statusCode).toBe(404);
  });
});

describe("concurrent writes by the same person", () => {
  function held() {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let firstIn!: () => void;
    const firstEntered = new Promise<void>(r => (firstIn = r));
    return {
      get entered() {
        return entered;
      },
      release: () => release(),
      firstEntered,
      hooks: {
        afterUserLock: async () => {
          entered++;
          if (entered === 1) {
            firstIn();
            await gate;
          }
        },
      },
    };
  }

  it("while an upload is paused holding the users row lock, the same person's select is blocked; after release the select takes effect, and exactly one current avatar remains", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    // Inserted via seed: the hook's first entry must be left for the upload that follows.
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const sel = select(app, alice.id, { candidateId: seeded });
      pending.push(sel);
      expect(await waitForBlockedOrSettled(db.$client, sel)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rs] = await Promise.all([up, sel]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rs.statusCode, rs.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isCurrent)).toHaveLength(1);
    // The select is queued after the upload, so the final current avatar is the selected one.
    expect(rows.find(r => r.isCurrent)!.id).toBe(seeded);
  });

  it("while an upload is paused holding the users row lock, the same person's re-crop is blocked; after release both complete", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const recrop = recropAvatar(app, alice.id, seeded, { display: webpOf(500), crop: NEW_CROP, version: 1 });
      pending.push(recrop);
      expect(await waitForBlockedOrSettled(db.$client, recrop)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rr] = await Promise.all([up, recrop]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rr.statusCode, rr.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    expect((await rowOf(db, seeded))!.version).toBe(2);
    expect(await rowsOf(db, alice.id)).toHaveLength(2);
  });

  it("while an upload is paused holding the users row lock, the same person's delete is blocked; after release both complete", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const del = remove(app, alice.id, seeded);
      pending.push(del);
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rd] = await Promise.all([up, del]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rd.statusCode, rd.body).toBe(204);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(seeded);
    expect(rows[0]!.isCurrent).toBe(true);
  });

  it("two selects waiting on each other: the one that gets the lock later takes effect, both 200, exactly one current avatar remains", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const x = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const y = await seedAvatarRow(db, { userId: alice.id, originalSize: 800, displaySize: 100 });
    const z = await seedAvatarRow(db, { userId: alice.id, originalSize: 700, displaySize: 100 });
    let pending: Array<Promise<unknown>> = [];
    try {
      const first = select(app, alice.id, { candidateId: y });
      pending.push(first);
      await h.firstEntered;
      const second = select(app, alice.id, { candidateId: z });
      pending.push(second);
      expect(await waitForBlockedOrSettled(db.$client, second)).toBe("blocked");
      h.release();
      const [r1, r2] = await Promise.all([first, second]);
      pending = [];
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r2.statusCode, r2.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows.filter(r => r.isCurrent).map(r => r.id)).toEqual([z]);
    expect(rows.map(r => r.id).sort()).toEqual([x, y, z].sort());
  });
});

describe("access boundaries of the avatar management endpoints", () => {
  it("not signed in 401, Bearer only (API token) 401; re-crop with cross-origin Origin 403; no data changed in any case", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const { token } = await seedTokenForUser(db, alice.id);
    for (const headers of [{}, bearer(token)]) {
      const label = Object.keys(headers).length === 0 ? "未登入" : "Bearer";
      expect((await recropAvatar(app, alice.id, id, { cookies: null, headers })).statusCode, `${label} recrop`).toBe(401);
      expect((await app.inject({ method: "PUT", url: "/api/auth/avatar", payload: { candidateId: null }, headers })).statusCode, `${label} select`).toBe(401);
      expect((await app.inject({ method: "DELETE", url: `/api/auth/avatars/${id}`, headers })).statusCode, `${label} delete`).toBe(401);
      expect((await app.inject({ method: "GET", url: `/api/auth/avatars/${id}/original`, headers })).statusCode, `${label} original`).toBe(401);
    }
    const cross = await recropAvatar(app, alice.id, id, { headers: { origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(403);
    expect(await rowOf(db, id)).toEqual(before);
  });
});

const readDisplay = async (app: Ctx["app"], userId: string, id: string, query = "") =>
  app.inject({ method: "GET", url: `/api/avatars/${id}${query}`, cookies: await cookieOf(userId) });

describe("GET /api/avatars/:id: read the display image", () => {
  it("others can read it too: 200, bytes equal; content-type is the DB value, plus nosniff and CSP sandbox", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const display = webpOf(500);
    const id = await uploaded(app, alice.id, { display });
    const res = await readDisplay(app, bob.id, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(Buffer.compare(res.rawPayload, display)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });

  it("content-type comes from what the DB stores, not inferred from content or URL", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    await db.update(userAvatars).set({ displayMime: "image/jpeg" }).where(eq(userAvatars.id, id));
    expect((await readDisplay(app, alice.id, id)).headers["content-type"]).toBe("image/jpeg");
  });

  it("?v= equal to the current version -> immutable; unequal, missing, empty string, 1.0, 01 and array forms are all no-cache", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const id = await uploaded(app, alice.id);
    expect((await readDisplay(app, bob.id, id, "?v=1")).headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    for (const q of ["", "?v=2", "?v=", "?v=1.0", "?v=01", "?v=1&v=1", "?v=0x1"]) {
      expect((await readDisplay(app, bob.id, id, q)).headers["cache-control"], q).toBe("private, no-cache");
    }
    const re = await recropAvatar(app, alice.id, id, { display: webpOf(400), version: 1 });
    expect(re.statusCode, re.body).toBe(200);
    expect((await readDisplay(app, bob.id, id, "?v=1")).headers["cache-control"]).toBe("private, no-cache");
    expect((await readDisplay(app, bob.id, id, "?v=2")).headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  });

  it("is_current is ignored: after changing the current avatar an old candidate's id can still be read", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const first = await uploaded(app, alice.id);
    const second = await uploaded(app, alice.id);
    expect((await select(app, alice.id, { candidateId: second })).statusCode).toBe(200);
    expect((await rowOf(db, first))!.isCurrent).toBe(false);
    expect((await readDisplay(app, bob.id, first)).statusCode).toBe(200);
    expect((await select(app, alice.id, { candidateId: null })).statusCode).toBe(200);
    expect((await readDisplay(app, bob.id, second)).statusCode).toBe(200);
  });

  it("uppercase uuid works; nonexistent, not-a-uuid and deleted ids all give the same 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    expect((await readDisplay(app, alice.id, id.toUpperCase())).statusCode).toBe(200);
    const missing = await readDisplay(app, alice.id, "00000000-0000-4000-8000-000000000000");
    const junk = await readDisplay(app, alice.id, "not-a-uuid");
    expect((await remove(app, alice.id, id)).statusCode).toBe(204);
    const gone = await readDisplay(app, alice.id, id);
    for (const res of [missing, junk, gone]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    expect(junk.body).toBe(missing.body);
    expect(gone.body).toBe(missing.body);
  });

  it("OIDC candidate with a pending display image: the owner reads the original (no-cache, even if ?v= matches), others get 404", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 700, displaySize: 0 });
    const original = pngOf(700);
    await writeFile(path.join(uploadsDir, (await rowOf(db, id))!.originalFile), original);
    const own = await readDisplay(app, alice.id, id, "?v=1");
    expect(own.statusCode, own.body).toBe(200);
    expect(Buffer.compare(own.rawPayload, original)).toBe(0);
    expect(own.headers["content-type"]).toBe("image/png");
    expect(own.headers["cache-control"]).toBe("private, no-cache");
    expect(own.headers["x-content-type-options"]).toBe("nosniff");
    expect(own.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    const other = await readDisplay(app, bob.id, id);
    const missing = await readDisplay(app, bob.id, "00000000-0000-4000-8000-000000000000");
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect(other.headers["content-security-policy"]).toBe(missing.headers["content-security-policy"]);
    expect(other.headers["content-type"]).toBe(missing.headers["content-type"]);
  });

  it("pending candidate, owner reads but the original file is missing -> 404 (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    expect((await readDisplay(app, alice.id, id)).statusCode).toBe(404);
  });

  it("not signed in 401, Bearer only (API token) 401", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const { token } = await seedTokenForUser(db, alice.id);
    for (const headers of [{}, bearer(token)]) {
      expect((await app.inject({ method: "GET", url: `/api/avatars/${id}`, headers })).statusCode).toBe(401);
    }
  });
});
