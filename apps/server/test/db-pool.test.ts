/**
 * Failure shape of the fuse, tested directly against `createPool` (`buildTestApp` uses `freshDb()`'s own pool and can't reach the wiring in `index.ts`).
 * The misuse it guards against: awaiting the same pool while holding a transaction connection. Without the fuse this hangs forever; with it those requests time out and reject and the pool recovers.
 */
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";

describe("createPool (#175 fuse)", () => {
  // Own 5 s timeout: if connectionTimeoutMillis were removed this goes red within 5 s, without waiting for the config's 120 s or depending on the config.
  it("max=2, timeout 300ms: awaiting the same pool while holding transaction connections -> timeout rejects, no permanent hang; later queries recover", async () => {
    const pool = createPool({ databaseUrl: process.env.TEST_DATABASE_URL!, databasePoolMax: 2, databasePoolConnectionTimeoutMs: 300 });
    try {
      // A barrier rather than sleep: both violators ask for the third connection together only after both really hold one. A fixed 30 ms assumed both had got theirs;
      // on CI where pool.connect() is slower, the earlier violator would run pool.query before the other got its connection, steal the second connection and get "ok"
      // (a timing race). The barrier makes no timing assumption.
      let arrived = 0;
      let release!: () => void;
      const allArrived = new Promise<void>(r => (release = r));
      const arrive = () => {
        if (++arrived === 2) release();
      };
      // Second barrier: each held connection is released only after both violators' third requests have a result. Otherwise the one that times out first releases
      // its connection and a request that times out later (its timer delayed by a busy event loop) gets it and returns "ok" (#256).
      let settled = 0;
      let releaseSettled!: () => void;
      const allSettled = new Promise<void>(r => (releaseSettled = r));
      const settle = () => {
        if (++settled === 2) releaseSettled();
      };
      const violator = async () => {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await c.query("select 1");
          arrive();
          await allArrived; // both connections are held, the pool is full
          let outcome: string;
          try {
            await pool.query("select 2"); // third connection: pool full -> waits until timeout
            outcome = "ok";
          } catch (err) {
            outcome = (err as Error).message;
          }
          settle();
          await allSettled; // release the connection only after the other has a result too
          if (outcome === "ok") await c.query("commit");
          else await c.query("rollback").catch(() => {});
          return outcome;
        } catch (err) {
          await c.query("rollback").catch(() => {});
          return (err as Error).message;
        } finally {
          c.release();
        }
      };
      const started = Date.now();
      const results = await Promise.all([violator(), violator()]);
      expect(results).toEqual(["timeout exceeded when trying to connect", "timeout exceeded when trying to connect"]);
      expect(Date.now() - started).toBeLessThan(5_000);
      await expect(pool.query("select 3 as n")).resolves.toMatchObject({ rows: [{ n: 3 }] });
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 5_000);
});
