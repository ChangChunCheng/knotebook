import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { createTrashPurger } from "../src/trash/purge.js";
import { deleteUploadFiles, uploadFilePath } from "../src/uploads/service.js";
import { seedNote, seedUser, sleep, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { seedAttachment } from "./storage-helpers.js";
import { inject, markTrashed } from "./trash-helpers.js";

const silent = pino({ level: "silent" }) as unknown as FastifyBaseLogger;
const exists = async (db: Db, id: string) => (await db.$client.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;
const uploadRow = async (db: Db, id: string) => (await db.$client.query(`select 1 from uploads where id = $1`, [id])).rowCount === 1;
const setRetention = (db: Db, v: number | null) => db.execute(sql`update site_settings set trash_retention_days = ${v}`);
const expired = async (db: Db, owner: string, ago = "8 days") => {
  const n = await seedNote(db, { ownerId: owner });
  await markTrashed(db.$client, n.id, owner, ago);
  return n.id;
};

describe("expiry boundary and attachments", () => {
  it("notes of a disabled account are purged too; deleted 7 days + 1 minute ago goes, 7 days - 1 minute ago and live notes stay", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db, { disabled: true });
    const old = await seedNote(db, { ownerId: owner.id });
    await markTrashed(db.$client, old.id, owner.id, "7 days 1 minute");
    const up = await seedAttachment(db, uploadsDir, old.id, owner.id, 12);
    const fresh = await seedNote(db, { ownerId: owner.id });
    await markTrashed(db.$client, fresh.id, owner.id, "6 days 23 hours 59 minutes");
    const live = await seedNote(db, { ownerId: owner.id });
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);

    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, old.id)).toBe(false);
    expect(await uploadRow(db, up)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(false);
    expect(await exists(db, fresh.id)).toBe(true);
    expect(await exists(db, live.id)).toBe(true);
  });
});

describe("a change of retention days takes effect on the next round", () => {
  it("NULL deletes nothing, after setting back to 7 it deletes; shortening likewise", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    const a = await expired(db, owner.id, "30 days");
    await setRetention(db, null);
    expect(await purger.runOnce()).toBe(0);
    expect(await exists(db, a)).toBe(true);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, a)).toBe(false);

    const b = await expired(db, owner.id, "10 days");
    await setRetention(db, 30);
    expect(await purger.runOnce()).toBe(0);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, b)).toBe(false);
  });
});

describe("per-round limit", () => {
  it("batchSize 2, maxBatches 3, 7 notes due -> 6 then 1", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    for (let i = 0; i < 7; i += 1) await expired(db, owner.id);
    const purger = createTrashPurger({ db, log: silent, uploadsDir, batchSize: 2, maxBatches: 3 });
    expect(await purger.runOnce()).toBe(6);
    expect(await purger.runOnce()).toBe(1);
  });
});

describe("concurrent with restore (SKIP LOCKED)", () => {
  it("while restore holds the lock runOnce returns 0 without waiting; after release x is alive", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    const hook: GroupTestHook = async point => {
      if (point === "note-restore-locked") {
        entered();
        await gate;
      }
    };
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: hook });
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const restoring = inject(app, "POST", "/api/trash/restore", owner.id, { ids: [x] });
    await inside;
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    const run = purger.runOnce();
    expect(await waitForBlockedOrSettled(db.$client, run)).toBe("settled");
    expect(await run).toBe(0);
    release();
    const res = await restoring;
    expect(res.statusCode, res.body).toBe(200);
    expect(await exists(db, x)).toBe(true);
    const { rows } = await db.$client.query(`select deleted_at from notes where id = $1`, [x]);
    expect(rows[0].deleted_at).toBeNull();
  });
});

describe("re-entry and stop", () => {
  it("two at once: the second returns 0, total equals the number due; the second never opened a transaction (a re-entry guard besides SKIP LOCKED)", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    for (let i = 0; i < 3; i += 1) await expired(db, owner.id);
    let txs = 0;
    const groupTestHook: GroupTestHook = async point => {
      if (point === "trash-purge-locked") txs += 1;
    };
    const purger = createTrashPurger({ db, log: silent, uploadsDir, groupTestHook });
    const [a, b] = await Promise.all([purger.runOnce(), purger.runOnce()]);
    expect(b).toBe(0);
    expect(a + b).toBe(3);
    expect(txs, "清理交易只開一次").toBe(1);
  });

  it("after stop() runOnce returns 0 and deletes nothing", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    await purger.stop();
    expect(await purger.runOnce()).toBe(0);
    expect(await exists(db, x)).toBe(true);
  });
});

describe("log does not carry the title", () => {
  it("output contains purged:1 and not the title marker string", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const marker = "SECRET-TITLE-MARKER-9f3a";
    const n = await seedNote(db, { ownerId: owner.id }, { title: marker });
    await markTrashed(db.$client, n.id, owner.id, "8 days");
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ level: "info" }, sink) as unknown as FastifyBaseLogger;
    expect(await createTrashPurger({ db, log, uploadsDir }).runOnce()).toBe(1);
    expect(out).toContain('"purged":1');
    expect(out).not.toContain(marker);
  });
});

describe("scheduling", () => {
  it("startTrashPurge -> due notes disappear within 5 s; ones created after app.close() are not deleted", async () => {
    const { app, db } = await buildTestApp({ startTrashPurge: true, trashPurgeFirstDelayMs: 50, trashPurgeIntervalMs: 50 });
    const owner = await seedUser(db);
    const a = await expired(db, owner.id);
    await expect.poll(() => exists(db, a), { timeout: 5_000 }).toBe(false);
    await app.close();
    const b = await expired(db, owner.id);
    await sleep(300);
    expect(await exists(db, b)).toBe(true);
  });

  it("without startTrashPurge -> nothing scheduled", async () => {
    const { app, db } = await buildTestApp({ trashPurgeFirstDelayMs: 50, trashPurgeIntervalMs: 50 });
    const owner = await seedUser(db);
    const a = await expired(db, owner.id);
    await sleep(300);
    expect(await exists(db, a)).toBe(true);
    await app.close();
  });
});

describe("a failing transaction does not delete files first", () => {
  it("trigger raise -> runOnce rejects, rows/uploads/disk files all still there; after removing the trigger the next run deletes them", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const up = await seedAttachment(db, uploadsDir, x, owner.id, 12);
    await db.$client.query(
      `create function pu9_boom() returns trigger language plpgsql as $$ begin if old.id = '${x}' then raise exception 'pu9 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger pu9_trg before delete on notes for each row execute function pu9_boom()`);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    await expect(purger.runOnce()).rejects.toThrow();
    expect(await exists(db, x)).toBe(true);
    expect(await uploadRow(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);
    await db.$client.query(`drop trigger pu9_trg on notes`);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, x)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(false);
  });
});

describe("the log of a failed file delete records only name/code/uploadId", () => {
  it("missing file -> the keys of the log.error object are exactly name, code, uploadId, no err", async () => {
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "kn-pu10-"));
    const calls: unknown[] = [];
    await deleteUploadFiles(uploadsDir, ["00000000-0000-4000-8000-000000000001"], { error: obj => calls.push(obj) });
    expect(calls).toEqual([{ name: "Error", code: "ENOENT", uploadId: "00000000-0000-4000-8000-000000000001" }]);
  });
});

describe("unreadable site_settings row", () => {
  it("runOnce returns 0, warn { table }, nothing deleted", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    await db.$client.query(`delete from site_settings`);
    const lines: Array<Record<string, unknown>> = [];
    const log = { warn: (o: Record<string, unknown>) => lines.push(o), info: () => undefined } as unknown as FastifyBaseLogger;
    expect(await createTrashPurger({ db, log, uploadsDir }).runOnce()).toBe(0);
    expect(lines).toEqual([{ table: "site_settings" }]);
    expect(await exists(db, x)).toBe(true);
  });
});

describe("a failure in batch k still records the count already deleted before it", () => {
  it("batchSize 1, the second note's delete is blocked by a trigger -> rejects, the log has purged:1", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    await expired(db, owner.id, "10 days");
    const y = await expired(db, owner.id, "9 days");
    await db.$client.query(
      `create function pu12_boom() returns trigger language plpgsql as $$ begin if old.id = '${y}' then raise exception 'pu12 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger pu12_trg before delete on notes for each row execute function pu12_boom()`);
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ level: "info" }, sink) as unknown as FastifyBaseLogger;
    await expect(createTrashPurger({ db, log, uploadsDir, batchSize: 1 }).runOnce()).rejects.toThrow();
    expect(out).toContain('"purged":1');
    expect(await exists(db, y)).toBe(true);
  });
});
