/** The search transaction's `SET LOCAL jit = off` (`notes/tx/search-query.ts`) must not leak past the transaction. */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { freshDb } from "./helpers.js";
import { seedUser } from "./group-helpers.js";
import { seedIndexedNote } from "./search-helpers.js";
import { runNoteSearchInTx } from "../src/notes/tx/search-query.js";
import { createDb } from "../src/db/index.js";

describe("search transaction turns JIT off", () => {
  it("jit is off inside the transaction and back to its original value on the same connection afterwards", async () => {
    const fresh = await freshDb();
    const u = await seedUser(fresh.db);
    await seedIndexedNote(fresh.db, { ownerId: u.id }, "jit", [{ id: "p", text: "kubernetes" }]);
    // max: 1 keeps the before/during/after probes on one connection; otherwise a leaked session-level SET would go unnoticed.
    const pool = new Pool({ connectionString: fresh.url, max: 1 });
    try {
      const db = createDb(pool);
      const probe = sql`select current_setting('jit') as jit, pg_backend_pid() as pid`;
      type Probe = { jit: string; pid: number };
      const before = (await db.execute<Probe>(probe)).rows[0]!;
      const during = await db.transaction(async tx => {
        const r = await runNoteSearchInTx(tx, { userId: u.id, query: "kubernetes", limit: 20 });
        expect(r.rows).toHaveLength(1);
        return (await tx.execute<Probe>(probe)).rows[0]!;
      });
      const after = (await db.execute<Probe>(probe)).rows[0]!;
      expect(before.jit).toBe("on");
      expect(during.jit).toBe("off");
      expect(after.jit).toBe(before.jit);
      expect(new Set([before.pid, during.pid, after.pid]).size).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
