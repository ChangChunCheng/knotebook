/**
 * The branch selects are single-use: drizzle builders are mutable, so reusing them in a
 * second `unionAll` silently yields a malformed query, and the corruption is retroactive (the first
 * query's `toSQL()` changes too) (guard: `test/unit/mcp-query-builders.test.ts`). Visibility
 * semantics live only in `notes/list-query.ts`.
 * ORDER BY on a set operation accepts only output column names, so rank is aliased first.
 */
import { desc, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";

export interface NoteListCursor {
  updatedAt: Date;
  id: string;
}

/**
 * The sort key is truncated to milliseconds: `updated_at` has microseconds but the cursor
 * goes through JS `Date` (milliseconds), so a microsecond key would silently drop rows in
 * the same millisecond. It must be a named output column (set-operation ORDER BY).
 * `.mapWith(notes.updatedAt)` is required: a raw `sql` expression has no column, so drizzle
 * would return pg's raw string and `toISOString()` would throw (tsc can't catch it). Numbers are
 * unaffected (node-postgres's int parser stays), so `rank` in `notes/search-sql.ts` needs no `mapWith`.
 */
const updatedAtMsExpr = sql`date_trunc('milliseconds', ${notes.updatedAt})`.mapWith(notes.updatedAt);

export function buildNoteListQuery(
  db: Db,
  opts: { userId: string; cursor: NoteListCursor | null; limit: number }
) {
  // A tuple comparison (an AND of two conditions would drop rows at equal timestamps); the left side needs the sort key's precision.
  const keyset: SQL | undefined =
    opts.cursor === null
      ? undefined
      : sql`(${updatedAtMsExpr}, ${notes.id}) < (${opts.cursor.updatedAt}, ${opts.cursor.id})`;
  const updatedAtMs = updatedAtMsExpr.as("updated_at_ms");
  const { owned, shared, grouped } = visibleNoteBranches(db, opts.userId, {
    extraWhere: keyset,
    extra: { updatedAtMs },
  });
  // Row `limit + 1` only decides `nextCursor`.
  return unionAll(owned, shared, grouped)
    .orderBy(desc(updatedAtMs), desc(notes.id))
    .limit(opts.limit + 1);
}
