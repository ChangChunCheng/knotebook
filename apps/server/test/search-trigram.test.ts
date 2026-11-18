/** Body search trigram path: `nss_body_trgm_idx` (migration 0042) and `usesTrigramPath` in `notes/search-sql.ts`. */
import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.js";
import { seedUser } from "./group-helpers.js";
import { seedIndexedNote } from "./search-helpers.js";
import { escapeLike } from "../src/db/like.js";
import { buildNoteSearchQuery } from "../src/notes/search-sql.js";
import { searchNotesForUser } from "../src/notes/search-query.js";
import { runNoteSearchInTx } from "../src/notes/tx/search-query.js";
import type { Db } from "../src/db/index.js";

describe("match form equivalence", () => {
  it("lower(x) LIKE lower('%'||escapeLike(q)||'%') agrees with position(lower(q) in lower(x)) > 0 on every case", async () => {
    const { pool } = await freshDb();
    const cases: Array<[string, string]> = [
      ["50%_off\\x", "50%_off\\x"],
      ["50%_off\\x", "%_OFF\\"],
      ["50 percent off", "50%"],
      ["a_c", "a_c"],
      ["abc", "a_c"],
      ["back\\slash", "\\"],
      ["back\\\\double", "\\\\"],
      ["single\\only", "\\\\"],
      ["Résumé", "RÉSUMÉ"],
      ["İstanbul", "istanbul"],
      ["Straße", "STRASSE"],
      ["ΣΑΣ", "σας"],
      ["資料庫設計", "資料庫"],
      ["資料庫設計", "設計"],
      ["資料庫設計", "庫設計師"],
      ["foo bar baz", "o b"],
      ["emoji 😀😀 here", "😀😀"],
      ["", "abc"],
      ["abc", ""],
    ];
    for (const [x, q] of cases) {
      const r = await pool.query(
        "select position(lower($2) in lower($1)) > 0 as a, lower($1) like lower($3) as b",
        [x, q, "%" + escapeLike(q) + "%"],
      );
      expect(r.rows[0].b, `x=${JSON.stringify(x)} q=${JSON.stringify(q)}`).toBe(r.rows[0].a);
    }
  });
});

describe("hits through the real queries", () => {
  it("MCP, bodyOnly and paged calls find the expected notes for short, long and % _ \\ queries", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const a = await seedIndexedNote(db, { ownerId: u.id }, "alpha", [{ id: "p", text: "progress 100%_done\\path here" }]);
    const b = await seedIndexedNote(db, { ownerId: u.id }, "beta", [{ id: "p", text: "Résumé of kubernetes 部署" }]);
    const c = await seedIndexedNote(db, { ownerId: u.id }, "gamma", [{ id: "p", text: "資料庫設計 notes" }]);
    const d = await seedIndexedNote(db, { ownerId: u.id }, "delta", [{ id: "p", text: "100 percent done" }]);
    const expected: Array<[string, string[]]> = [
      ["100%", [a.id]],
      ["_done\\p", [a.id]],
      ["%_d", [a.id]],
      ["RÉSUMÉ", [b.id]],
      ["KUBERNETES", [b.id]],
      ["部署", [b.id]],
      ["資料庫", [c.id]],
      ["100", [a.id, d.id]],
      ["zzqx", []],
    ];
    const sorted = (ids: string[]) => [...ids].sort();
    for (const [q, ids] of expected) {
      const mcp = await searchNotesForUser(db, { userId: u.id, query: q, limit: 20 });
      expect(sorted(mcp.rows.map(r => r.id)), `MCP q=${q}`).toEqual(sorted(ids));
      const bodyOnly = await db.transaction(tx => runNoteSearchInTx(tx, { userId: u.id, query: q, limit: 20, bodyOnly: true }));
      expect(sorted(bodyOnly.rows.map(r => r.id)), `bodyOnly q=${q}`).toEqual(sorted(ids));
      const paged = await db.transaction(tx => runNoteSearchInTx(tx, { userId: u.id, query: q, limit: 20, page: { after: null } }));
      expect(sorted(paged.rows.map(r => r.id)), `page q=${q}`).toEqual(sorted(ids));
    }
  });
});

type PlanNode = { "Node Type": string; "Index Name"?: string; "Actual Loops"?: number; Plans?: PlanNode[] };

function executedTrigramScans(node: PlanNode): number {
  const self = node["Index Name"] === "nss_body_trgm_idx" && (node["Actual Loops"] ?? 0) >= 1 ? 1 : 0;
  return self + (node.Plans ?? []).reduce((n, child) => n + executedTrigramScans(child), 0);
}

/**
 * Fixture for the plan assertions: one user owns 2000 notes with 20 sections of ~500 characters each (a fixed vocabulary
 * that contains none of the query words); both tables are ANALYZEd.
 * The size matters (measured): whether the body EXISTS in WHERE becomes a hashed SubPlan depends on how many notes are
 * visible, and once hashed, whether the SubPlan uses a trigram bitmap scan or a seq scan depends on the size of
 * note_search_sections. With 1000 notes × 3-20 short sections the planner picks a seq scan inside the SubPlan; at
 * 2000 × 20 × ~500 characters (40k sections) both shapes use nss_body_trgm_idx. Takes about 8-9 s, mostly GIN maintenance.
 */
async function seedPlanFixture(db: Db, pool: import("pg").Pool): Promise<string> {
  const u = await seedUser(db);
  await pool.query(
    `insert into notes (owner_id, title, slug) select $1, 'plan note ' || g, 'plan-' || g from generate_series(1, 2000) g`,
    [u.id],
  );
  await pool.query(
    `insert into note_search_sections (note_id, section_id, ord, body)
     select n.id, 's' || o, o,
            repeat('the editor keeps every version of this note and the team can share it with a group ', 6) || o || ' ' || n.title
       from notes n cross join generate_series(1, 20) o
      where n.owner_id = $1`,
    [u.id],
  );
  await pool.query("analyze notes, note_search_sections");
  return u.id;
}

async function explain(pool: import("pg").Pool, db: Db, userId: string, query: string, bodyOnly: boolean): Promise<PlanNode> {
  const { sql, params } = buildNoteSearchQuery(db, { userId, query, limit: 20, ...(bodyOnly ? { bodyOnly: true } : {}) }).toSQL();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local jit = off");
    const r = await client.query(`explain (analyze, format json) ${sql}`, params);
    await client.query("rollback");
    return (r.rows[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  } finally {
    client.release();
  }
}

describe("trigram index is executed for the real query shapes", () => {
  it("a 3+ character query executes nss_body_trgm_idx in both the OR shape (no hits) and bodyOnly; a 2-character query does not", async () => {
    const { db, pool } = await freshDb();
    const userId = await seedPlanFixture(db, pool);
    // The OR shape uses a query with no hits: the SELECT list's body_hit is also a hashed SubPlan, but it only runs for
    // rows that pass WHERE. With no hits it never runs, so a trigram node with Actual Loops >= 1 must come from WHERE.
    expect(executedTrigramScans(await explain(pool, db, userId, "qzxv", false))).toBeGreaterThanOrEqual(1);
    expect(executedTrigramScans(await explain(pool, db, userId, "qzxv", true))).toBeGreaterThanOrEqual(1);
    // Control: a 2-character query takes the position() path.
    expect(executedTrigramScans(await explain(pool, db, userId, "qz", false))).toBe(0);
  });
});
