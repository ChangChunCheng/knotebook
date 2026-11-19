/**
 * #181: scheduling constants of the retention purge. The docs state concrete figures (the Trash section and upgrade section of docs/self-hosting.md,
 * docs/known-limitations.md, docs/api.md, the CHANGELOG upgrade notes), so changing a constant means changing the docs too.
 */
import { describe, expect, it } from "vitest";
import { TRASH_PURGE_BATCH, TRASH_PURGE_FIRST_DELAY_MS, TRASH_PURGE_INTERVAL_MS, TRASH_PURGE_MAX_BATCHES } from "../../src/trash/purge.js";

describe("trash purge scheduling constants", () => {
  it("pins the \"first pass after 5 minutes / one pass per hour\" in docs/self-hosting.md and the CHANGELOG: first pass at 5 minutes, then every 60 minutes", () => {
    expect(TRASH_PURGE_FIRST_DELAY_MS).toBe(5 * 60 * 1000);
    expect(TRASH_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("pins the \"at most 2,000 notes per pass\" in docs/known-limitations.md, self-hosting.md, api.md and the CHANGELOG: batches of 100 x 20 batches per pass", () => {
    expect(TRASH_PURGE_BATCH).toBe(100);
    expect(TRASH_PURGE_MAX_BATCHES).toBe(20);
    expect(TRASH_PURGE_BATCH * TRASH_PURGE_MAX_BATCHES).toBe(2000);
  });
});
