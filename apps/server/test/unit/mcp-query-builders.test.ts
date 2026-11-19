/**
 * #108: guard that `mcp/queries.ts` builds a fresh set of branch selects on every call.
 *
 * **Why**: drizzle's select builder is **mutable and single-use**. Reusing the same `owned`/`shared` for a second `unionAll(...)` gives a malformed
 * query with an extra `union all` segment and **throws no exception**; the contamination is also **retroactive**: after the second is built, `toSQL()`
 * on the first query object turns malformed too.
 *
 * This guards that **our assembly functions build fresh every time**, not drizzle's behaviour; if drizzle fixes it, this family stays green, which is what we want.
 *
 * No connection, only `.toSQL()`: `pg.Pool` points at an unreachable address (port 1) and never connects.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb } from "../../src/db/index.js";
import { buildNoteListQuery } from "../../src/mcp/queries.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildNoteSearchQuery as buildFullTextQuery, buildSearchMatchesQuery } from "../../src/notes/search-sql.js";
import { GOLDEN_PARAMS, GOLDEN_SQL, GOLDEN_USER } from "./search-sql-golden.js";

const pool = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:1/none" });
const db = createDb(pool);

afterAll(async () => {
  await pool.end();
});

const USER = randomUUID();
const CURSOR = { updatedAt: new Date("2026-09-07T00:00:00.000Z"), id: randomUUID() };

const countUnionAll = (sql: string): number => sql.split("union all").length - 1;

describe("#108 buildNoteListQuery", () => {
  it("calling twice: both SQL texts contain exactly two union all (three branches)", () => {
    const first = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    const second = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    expect(countUnionAll(first.toSQL().sql)).toBe(2);
    expect(countUnionAll(second.toSQL().sql)).toBe(2);
  });

  it("after building the second, `toSQL()` on the first object still contains exactly two union all (three branches) (retroactive contamination)", () => {
    const first = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    expect(countUnionAll(first.toSQL().sql)).toBe(2);
  });

  // This also guards the silent-row-loss precision gap: the cursor only has milliseconds (JS `Date.toISOString()`), so the sort key and the left
  // side of the keyset predicate must first be `date_trunc('milliseconds', ...)`. Left at microseconds, rows in the same millisecond with a smaller
  // microsecond are cut off in bulk, with no error and no duplicate: they just vanish (an end-to-end case is on the integration side).
  it("SQL has a millisecond-precision keyset predicate and a deterministic order on the union", () => {
    const sql = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 }).toSQL().sql;
    // The keyset appears once in the where of each of the three selects, with the millisecond-truncated expression on the left.
    expect(sql.split(`(date_trunc('milliseconds', "notes"."updated_at"), "notes"."id") <`).length - 1).toBe(3);
    // Catches "the keyset's left side uses the raw column": that would be a different precision from the cursor.
    expect(sql).not.toContain(`("notes"."updated_at", "notes"."id") <`);
    // ORDER BY of a set operation accepts only output column names, so the sort key must be a named output column.
    expect(sql).toContain(`date_trunc('milliseconds', "notes"."updated_at") as "updated_at_ms"`);
    expect(sql).toContain(`order by "updated_at_ms" desc, "id" desc`);
    expect(sql).toMatch(/limit \$\d+$/);
  });

  it("without a cursor there is no keyset predicate and the other shapes are unchanged", () => {
    const sql = buildNoteListQuery(db, { userId: USER, cursor: null, limit: 50 }).toSQL().sql;
    expect(sql).not.toContain(`"notes"."id") <`);
    expect(countUnionAll(sql)).toBe(2);
    expect(sql).toContain(`order by "updated_at_ms" desc, "id" desc`);
  });
});

describe("#108 buildNoteSearchQuery", () => {
  it("calling twice: each contains exactly two union all (three branches), and the first object still has exactly two afterwards", () => {
    const first = buildFullTextQuery(db, { userId: USER, query: "hello", limit: 20 });
    const second = buildFullTextQuery(db, { userId: USER, query: "hello", limit: 20 });
    expect(countUnionAll(first.toSQL().sql)).toBe(2);
    expect(countUnionAll(second.toSQL().sql)).toBe(2);
    expect(countUnionAll(first.toSQL().sql)).toBe(2);
  });

  it("sorted by the output column name rank, and the match uses a non-pattern position() rather than like", () => {
    const { sql, params } = buildFullTextQuery(db, { userId: USER, query: "50%", limit: 20 }).toSQL();
    // `orderBy(rankExpr)` (putting the CASE expression straight into ORDER BY) is something drizzle can generate but pg rejects
    // (`invalid UNION/INTERSECT/EXCEPT ORDER BY clause`): the ORDER BY of a set operation accepts only output column names.
    expect(sql).toContain(`order by "rank" asc, "updated_at" desc, "id" desc`);
    expect(sql).not.toMatch(/order by[\s\S]*case when/);
    // Non-pattern matching: `%` isn't treated as a wildcard, so no ESCAPE is needed, and like/ilike must not appear.
    expect(sql.toLowerCase()).not.toContain(" like ");
    expect(sql.toLowerCase()).not.toContain(" ilike ");
    expect(sql).toContain("position(");
    // Third check: the query string is sent as a parameter, not in the SQL text.
    expect(sql).not.toContain("50%");
    expect(params).toContain("50%");
  });
});

describe("#93 notes/search-sql", () => {
  it("list statement: each of the three branches has an EXISTS subquery matching note_search_sections; rank is the fourth level; title_hit/body_hit; ordered by output columns; non-pattern", () => {
    const { sql, params } = buildFullTextQuery(db, { userId: USER, query: "50%", limit: 20 }).toSQL();
    expect(countUnionAll(sql)).toBe(2);
    expect(sql.split("note_search_sections").length - 1).toBeGreaterThanOrEqual(3);
    expect(sql.toLowerCase()).toContain("exists (");
    expect(sql).toContain("else 3 end");
    expect(sql).toContain(`"title_hit"`);
    expect(sql).toContain(`"body_hit"`);
    expect(sql).toContain(`order by "rank" asc, "updated_at" desc, "id" desc`);
    expect(sql.toLowerCase()).not.toContain(" like ");
    expect(sql).not.toContain("50%");
    expect(params).toContain("50%");
  });
  // #93: the bodyOnly/page options
  it("without the new options, toSQL() is byte-identical to the golden captured before paging was added (the MCP SQL is unchanged)", () => {
    const { sql, params } = buildFullTextQuery(db, { userId: GOLDEN_USER, query: "q", limit: 20 }).toSQL();
    expect(sql).toBe(GOLDEN_SQL);
    expect(params).toEqual(GOLDEN_PARAMS);
  });
  it("no options, bodyOnly: false, and page: undefined are byte-identical", () => {
    const base = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20 }).toSQL();
    const off = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20, bodyOnly: false }).toSQL();
    const noPage = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20, page: undefined }).toSQL();
    expect(off).toEqual(base);
    expect(noPage).toEqual(base);
  });
  it("bodyOnly: true gives different sql from the default, still exactly two union all", () => {
    const base = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20 }).toSQL();
    const body = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20, bodyOnly: true }).toSQL();
    expect(body.sql).not.toBe(base.sql);
    expect(countUnionAll(body.sql)).toBe(2);
  });
  it("page: with after null there is one more column, updated_at_key, and no keyset; with after set, the keyset values go through parameters", () => {
    const first = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20, page: { after: null } }).toSQL();
    expect(first.sql).toContain(`"updated_at_key"`);
    expect(first.sql).not.toContain("::timestamptz");
    const key = { rank: 2, updatedAtKey: "2026-01-01T00:00:00.123456Z", id: randomUUID() };
    const next = buildFullTextQuery(db, { userId: USER, query: "q", limit: 20, page: { after: key } }).toSQL();
    expect(next.sql).toContain("::timestamptz");
    expect(countUnionAll(next.sql)).toBe(2);
    expect(next.params).toEqual(expect.arrayContaining([key.updatedAtKey, key.id]));
    expect(next.sql).not.toContain(key.updatedAtKey);
    expect(next.sql).not.toContain(key.id);
  });
  it("calling twice builds fresh each time (single-use builders)", () => {
    const first = buildFullTextQuery(db, { userId: USER, query: "x", limit: 5 });
    buildFullTextQuery(db, { userId: USER, query: "x", limit: 5 });
    expect(countUnionAll(first.toSQL().sql)).toBe(2);
  });
  it("matches statement: the id list is in ($1, $2), not any(...); the query string goes through parameters; 3 per note", () => {
    const a = randomUUID();
    const b = randomUUID();
    const q = new PgDialect().sqlToQuery(buildSearchMatchesQuery({ query: "zeta", ids: [a, b] }));
    expect(q.sql).toMatch(/in \(\$\d+, \$\d+\)/);
    expect(q.sql.toLowerCase()).not.toContain("any(");
    expect(q.sql).not.toContain("zeta");
    expect(q.params).toEqual(expect.arrayContaining(["zeta", a, b]));
    expect(q.sql).toMatch(/rn <= \$\d+|rn <= 3/);
  });
});
