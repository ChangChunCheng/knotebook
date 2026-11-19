import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { siteLimits as siteLimitsTable } from "../src/db/schema.js";
import { ParsePool } from "../src/notes/editing/parse-pool.js";
import type { ParseLimits } from "../src/notes/editing/parse-settings.js";
import { createEditingRuntime, type EditingRuntime } from "../src/notes/editing/runtime.js";
import { buildCollabTestApp, buildTestApp, testConfig, testEditingRuntime } from "./helpers.js";

/** Same memory, time limit and queue wait as the site defaults (only the worker count differs): a configure after subscribing then does not replace every worker because memory differs. */
const START: ParseLimits = { workers: 1, workerMemoryMb: 1024, timeoutMs: 10_000, queueWaitMs: 45_000 };

// One runtime shared by the whole file (opening a real parse worker takes several seconds); each case resets the pool to START first.
let rt: EditingRuntime;
const pool = (): ParsePool => rt.parser as ParsePool;
beforeAll(() => {
  rt = createEditingRuntime(testConfig, START);
});
afterAll(async () => {
  await rt.close();
});
beforeEach(() => {
  pool().configure(START);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function appWithAdmin(opts: { editingFollowsSiteLimits?: boolean }) {
  const ctx = await buildCollabTestApp({ editing: rt, ...opts });
  const admin = await ctx.createUser({ email: "admin@example.com", password: "correct-horse-battery", isAdmin: true });
  return { ctx, admin };
}

describe("parse worker pool follows the site limits", () => {
  it("injected runtime with the flag: parseWorkers 1 -> 2, the pool's worker count becomes 2", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    expect(pool().stats().workers).toBe(1);
    await ctx.siteLimits.update(admin.id, { parseWorkers: 2 });
    await vi.waitFor(() => expect(pool().stats().workers).toBe(2));
    expect(pool().limits).toMatchObject({ workers: 2, workerMemoryMb: 1024 });
  });

  it("changing only the time limit: the auto queue wait follows, and the pool receives queueWaitMs 4 x 5000 + 5000", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    // Records the arguments only and does not forward to the real pool: what arrives is the complete parseLimits(), and the automatic worker count can reach 4 on multi-core machines - forwarding would really open extra 1 GiB workers.
    const spy = vi.spyOn(pool(), "configure").mockImplementation(() => {});
    await ctx.siteLimits.update(admin.id, { parseTimeoutMs: 5_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ timeoutMs: 5_000, queueWaitMs: 25_000 });
  });

  it("injected runtime without the flag -> no subscription: the pool does not change after parseWorkers changes", async () => {
    const { ctx, admin } = await appWithAdmin({});
    const spy = vi.spyOn(pool(), "configure");
    await ctx.siteLimits.update(admin.id, { parseWorkers: 2 });
    expect(ctx.siteLimits.get("parseWorkers")).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    expect(pool().stats().workers).toBe(1);
  });

  it("shared testEditingRuntime with the flag -> harness throws (three forms: no editing, explicit testEditingRuntime, buildTestApp)", async () => {
    const message = "testEditingRuntime is shared; pass your own editing runtime to follow site limits";
    // Compare result strings only: a successfully built app object is huge and printing it through expect would blow up vitest's memory (an app that did get built is closed by the harness's onTestFinished).
    const outcome = (p: Promise<unknown>) => p.then(() => "built", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(await outcome(buildCollabTestApp({ editingFollowsSiteLimits: true }))).toBe(message);
    expect(await outcome(buildCollabTestApp({ editing: testEditingRuntime, editingFollowsSiteLimits: true }))).toBe(message);
    expect(await outcome(buildTestApp({ editing: testEditingRuntime, editingFollowsSiteLimits: true }))).toBe(message);
  });

  it("pool configure throws -> update still resolves and site_limits is written; the next update is not stuck", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    const spy = vi.spyOn(pool(), "configure").mockImplementation(() => {
      throw new Error("configure failed");
    });
    await expect(ctx.siteLimits.update(admin.id, { parseWorkers: 2 })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = await ctx.db.select({ value: siteLimitsTable.value }).from(siteLimitsTable).where(eq(siteLimitsTable.key, "parseWorkers"));
    expect(rows).toEqual([{ value: 2 }]);
    expect(ctx.siteLimits.get("parseWorkers")).toBe(2);
    await expect(ctx.siteLimits.update(admin.id, { parseWorkers: 3 })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ctx.siteLimits.get("parseWorkers")).toBe(3);
  });
});
