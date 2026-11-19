import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { freshDb } from "./helpers.js";

// Every test_<random> database created by freshDb() must be DROPped when the test ends (issue #51): otherwise 400+ tests in one run
// accumulate hundreds of databases until CREATE DATABASE fails, which looks like a random flake. This pins the contract that close() drops the database it created.
describe("freshDb cleanup", () => {
  it("close() DROPs the database it created", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL 未設定");

    const { pool, close } = await freshDb();

    // freshDb() doesn't expose the database name, so read it back from the connection with current_database().
    const nameRes = await pool.query<{ name: string }>("SELECT current_database() AS name");
    const dbName = nameRes.rows[0]?.name;
    expect(dbName).toMatch(/^test_[0-9a-f]+$/);

    const admin = new Pool({ connectionString: baseUrl });
    try {
      const before = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      expect(before.rowCount).toBe(1);

      await close();

      const after = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      expect(after.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it("pool error events do not become uncaught after close()", async () => {
    const { pool, close } = await freshDb();
    await close();
    // WITH (FORCE) sends FATAL 57P01 to leftover connections whose `pool.end()` has resolved but whose socket isn't fully closed; it is re-emitted on the pool
    // through pg-pool's idleListener, and an EventEmitter without an error listener throws (a process-level uncaught error; vitest fails an otherwise green run,
    // hit in CI). This pins that close() attaches a swallowing listener: without that line the suite stays green because of the timing window, only this test fails.
    expect(() => pool.emit("error", new Error("straggler FATAL 57P01"))).not.toThrow();
  });
});
