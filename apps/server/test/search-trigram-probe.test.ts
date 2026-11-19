/** `probeCjkTrigrams` / `initCjkTrigramMode`: ask the database whether pg_trgm yields trigrams for CJK text (depends on LC_CTYPE). */
import { describe, expect, it, vi } from "vitest";
import { freshDb, freshEmptyDb } from "./helpers.js";
import { initCjkTrigramMode, probeCjkTrigrams, setCjkYieldsTrigrams, usesTrigramPath } from "../src/notes/search-sql.js";

describe("probeCjkTrigrams", () => {
  it("is true on a UTF-8 locale database", async () => {
    const { db } = await freshDb();
    expect(await probeCjkTrigrams(db)).toBe(true);
  });

  it("is false on a database created with LC_CTYPE 'C'", async () => {
    const { db, pool } = await freshEmptyDb({ cLocale: true });
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(await probeCjkTrigrams(db)).toBe(false);
  });
});

describe("initCjkTrigramMode against real databases", () => {
  it("sets the routing mode from the database locale and logs it", async () => {
    try {
      const utf8 = await freshDb();
      const log = { info: vi.fn(), warn: vi.fn() };
      await initCjkTrigramMode(utf8.db, log);
      expect(usesTrigramPath("資料庫")).toBe(true);
      expect(log.info).toHaveBeenCalledTimes(1);

      const c = await freshEmptyDb({ cLocale: true });
      await c.pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await initCjkTrigramMode(c.db, log);
      expect(usesTrigramPath("資料庫")).toBe(false);
      expect(usesTrigramPath("abc")).toBe(true);
    } finally {
      setCjkYieldsTrigrams(false);
    }
  });

  it("a failing probe (no pg_trgm) keeps the fallback and warns instead of throwing", async () => {
    try {
      setCjkYieldsTrigrams(true);
      const { db } = await freshEmptyDb();
      const log = { info: vi.fn(), warn: vi.fn() };
      await initCjkTrigramMode(db, log);
      expect(usesTrigramPath("資料庫")).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
    } finally {
      setCjkYieldsTrigrams(false);
    }
  });
});
