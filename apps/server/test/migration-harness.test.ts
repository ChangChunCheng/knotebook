import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";

// drizzle's migrate() can't stop at migration N and freshDb runs everything, so applyMigrationsThrough replays the committed SQL files and writes the ledger; runMigrations then runs only the remaining pending ones in a single transaction, so CONCURRENTLY fails naturally.
/**
 * `created_at` must be the journal entry's `when`: the skip rule only checks
 * "created_at of `order by created_at desc limit 1` < folderMillis" (checked against drizzle-orm 0.44.7 dialect.js), so writing
 * `Date.now()` would silently skip every later migration (journal `when`s are all in the past) and make the guard falsely green.
 * hash is the sha256 hex of the whole .sql text (NOT NULL, but not part of the skip rule).
 */

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");


describe("freshEmptyDb (clean DB entry that runs no migrations)", () => {
  it("returned DB has no public tables and no drizzle journal", async () => {
    const { pool } = await freshEmptyDb();
    const tables = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.rows[0].n).toBe(0);
    const drizzleSchema = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(drizzleSchema.rows[0].n).toBe(0);
  });
});

describe("applyMigrationsThrough (harness)", () => {
  it("replaying 0..last: sampled shape and bookkeeping shape (created_at = journal when; full equivalence is guarded by the equivalence case below)", async () => {
    const entries = journalEntries();
    const lastIdx = entries[entries.length - 1].idx;

    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, lastIdx);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((row: { table_name: string }) => row.table_name);
    for (const expected of ["users", "notes", "note_shares", "note_states", "uploads"]) {
      expect(names, expected).toContain(expected);
    }
    const publicToken = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(publicToken.rows[0].n).toBe(1);

    const ledger = await pool.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
    expect(ledger.rows.length).toBe(entries.length);
    entries.forEach((entry, i) => {
      expect(Number(ledger.rows[i].created_at), entry.tag).toBe(entry.when);
      const sql = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8");
      expect(ledger.rows[i].hash, entry.tag).toBe(createHash("sha256").update(sql).digest("hex"));
    });
  });

  it("after replaying through the last migration, runMigrations treats everything as applied (no rerun, no error) and the seed still runs", async () => {
    const entries = journalEntries();
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, entries[entries.length - 1].idx);

    // Guards the "wrongly thinks nothing ran" direction (it would re-CREATE existing tables and blow up); the wrong-created_at
    // direction (silent skip) is not observable here, the next case covers it.
    await expect(runMigrations(db)).resolves.toBeUndefined();

    const ledger = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(ledger.rows[0].n).toBe(entries.length);
    const actions = await pool.query(`SELECT count(*)::int AS n FROM ai_actions`);
    expect(actions.rows[0].n).toBeGreaterThan(0);
  });

  it("after applyThrough, runMigrations runs all remaining pending migrations (a wrong created_at silently skips them and this case catches it; the count assertion doesn't depend on which migration is last)", async () => {
    const entries = journalEntries();
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, entries[entries.length - 2].idx);
    await runMigrations(db);
    // runMigrations writes one ledger row per migration it really runs; a silent skip stops at N-1.
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(ledger.rows[0].n, "pending 必須被 runMigrations 跑完（被跳過＝資料案例守衛全假綠）").toBe(
      entries.length,
    );
  });

  it("mid-way failure leaves nothing behind (single transaction throughout, which is what makes CONCURRENTLY fail)", async () => {
    const entries = journalEntries();
    const { pool } = await freshEmptyDb();
    // PG indexes and tables share one relation namespace: occupy the index name 0001 creates so the replay
    // succeeds on 0000 and blows up midway through 0001.
    await pool.query(`CREATE TABLE note_shares_user_idx (x int)`);
    await expect(applyMigrationsThrough(pool, entries[entries.length - 1].idx)).rejects.toThrow();

    const users = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(users.rows[0].n, "0000 建的表必須隨整個 tx rollback").toBe(0);
    const drizzleSchema = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(drizzleSchema.rows[0].n).toBe(0);
  });

  it("can build an old-schema database (tag addressing pins the 0004/0005 pair so adding migrations doesn't drift)", async () => {
    const at0004 = await freshEmptyDb();
    await applyMigrationsThrough(at0004.pool, idxOfTag("0004_email-lower-index"));
    const before = await at0004.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(before.rows[0].n).toBe(0);

    const at0005 = await freshEmptyDb();
    await applyMigrationsThrough(at0005.pool, idxOfTag("0005_public-share"));
    const after = await at0005.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(after.rows[0].n).toBe(1);
  });

  it("applyThrough(last) and freshDb have truly equivalent public schemas (columns, indexes and constraints all compared; a sampled comparison would miss a dropped final statement in any migration)", async () => {
    const entries = journalEntries();
    const replayed = await freshEmptyDb();
    await applyMigrationsThrough(replayed.pool, entries[entries.length - 1].idx);
    const reference = await freshDb();

    const columnsSql = `SELECT table_name, column_name, data_type, is_nullable, column_default
                        FROM information_schema.columns WHERE table_schema = 'public'
                        ORDER BY table_name, column_name`;
    const indexesSql = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`;
    const constraintsSql = `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
                            FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                            ORDER BY tbl, conname`;

    for (const sql of [columnsSql, indexesSql, constraintsSql]) {
      const a = await replayed.pool.query(sql);
      const b = await reference.pool.query(sql);
      expect(a.rows).toEqual(b.rows);
    }
  });
});
