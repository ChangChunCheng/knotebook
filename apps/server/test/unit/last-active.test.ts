/** #267: LastActiveTracker's in-process throttling, cap and best-effort behaviour (never throws, only warns). The SQL condition layer is in the integration test `test/last-active.test.ts`. */
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { LAST_ACTIVE_WRITE_INTERVAL_MS } from "@knotebook/shared";
import type { Db } from "../../src/db/index.js";
import { LastActiveTracker } from "../../src/auth/last-active.js";

function fakeDb(impl: () => Promise<unknown> = () => Promise.resolve({ rowCount: 1 })) {
  const execute = vi.fn(impl);
  return { db: { execute } as unknown as Db, execute };
}
const quietLog = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };

describe("LastActiveTracker", () => {
  it("one user hits the DB once within the write interval, and again after the interval; different users are counted separately", async () => {
    let now = 1_000_000;
    const { db, execute } = fakeDb();
    const t = new LastActiveTracker(db, quietLog(), { now: () => now });
    await t.touch("u-1");
    await t.touch("u-1");
    now += LAST_ACTIVE_WRITE_INTERVAL_MS - 1;
    await t.touch("u-1");
    expect(execute).toHaveBeenCalledTimes(1);
    await t.touch("u-2");
    expect(execute).toHaveBeenCalledTimes(2);
    now += 1;
    await t.touch("u-1");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("UPDATE throws: not rethrown; log.warn once with an object carrying err and userId; 0 rows doesn't warn", async () => {
    const boom = new Error("db down");
    const log = quietLog();
    await expect(new LastActiveTracker(fakeDb(() => Promise.reject(boom)).db, log).touch("u-1")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ err: boom, userId: "u-1" });
    await new LastActiveTracker(fakeDb(() => Promise.resolve({ rowCount: 0 })).db, log).touch("u-2");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("the throttle table is capped: when full, expired entries are cleared first; if still full the whole table is cleared (no unbounded growth)", async () => {
    let now = 0;
    const { db, execute } = fakeDb();
    const t = new LastActiveTracker(db, quietLog(), { now: () => now, maxEntries: 3 });
    await t.touch("a");
    now = LAST_ACTIVE_WRITE_INTERVAL_MS; // a is exactly one interval old, which counts as expired
    await t.touch("b");
    await t.touch("c");
    expect(t.size).toBe(3);
    await t.touch("d");
    expect(t.size).toBe(3);
    await t.touch("b"); // b is still within the interval and still in the table -> no DB call
    expect(execute).toHaveBeenCalledTimes(4);
    await t.touch("e");
    expect(t.size).toBe(1);
    expect(execute).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 50; i++) await t.touch(`x-${i}`);
    expect(t.size).toBeLessThanOrEqual(3);
  });
});
