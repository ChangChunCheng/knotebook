/**
 * `deleteEndedOneTimeLinks` deletes only rows that ended (used/revoked/expired) over 30 days ago and doesn't wait for other rows'
 * locks. Each row uses a fresh user (avoids the partial unique index).
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { deleteEndedOneTimeLinks } from "../src/auth/one-time-link-cleanup.js";
import { freshDb } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";

/** Time columns are always SQL expressions (test constants, not user input); NULL is written as `null`. */
async function insertLink(pool: Pool, t: { created: string; expires: string; used?: string; revoked?: string }): Promise<string> {
  const u = await pool.query(`insert into users (email, display_name) values ($1, 'C') returning id`, [`otc-${randomUUID()}@example.com`]);
  const r = await pool.query(
    `insert into one_time_links (kind, token_hash, target_user_id, created_at, expires_at, used_at, revoked_at)
     values ('password_reset', $1, $2, ${t.created}, ${t.expires}, ${t.used ?? "null"}, ${t.revoked ?? "null"}) returning id`,
    [`h-${randomUUID()}`, u.rows[0].id],
  );
  return r.rows[0].id as string;
}

async function remaining(pool: Pool): Promise<string[]> {
  return (await pool.query(`select id from one_time_links`)).rows.map((r: { id: string }) => r.id).sort();
}

describe("deleteEndedOneTimeLinks", () => {
  it("end time = coalesce(used_at, revoked_at, expires_at), deleted only past 30 days", async () => {
    const { db, pool } = await freshDb();
    const ago = (s: string) => `now() - interval '${s}'`;
    const a = await insertLink(pool, { created: ago("31 days 1 hour"), expires: ago("30 days 23 hours"), used: ago("31 days") });
    const b = await insertLink(pool, { created: ago("31 days 1 hour"), expires: ago("30 days 23 hours"), revoked: ago("31 days") });
    const c = await insertLink(pool, { created: ago("31 days 2 hours"), expires: ago("31 days") });
    const d = await insertLink(pool, { created: ago("29 days 2 hours"), expires: ago("29 days") });
    const e = await insertLink(pool, { created: "now()", expires: "now() + interval '1 hour'" });
    const f = await insertLink(pool, { created: ago("29 days 1 hour"), expires: ago("28 days 23 hours"), used: ago("29 days") });
    // g: used 31 days ago but expires_at only 29 days ago: counted from the used time -> deleted
    const g = await insertLink(pool, { created: ago("32 days"), expires: ago("29 days"), used: ago("31 days") });
    // h: revoked 31 days ago but expires_at only 29 days ago: counted from the revoke time -> deleted
    const h = await insertLink(pool, { created: ago("32 days"), expires: ago("29 days"), revoked: ago("31 days") });
    // i: never used, never revoked, created_at 31 days ago but expires_at only 29 days ago: counted from the expiry -> kept
    const i = await insertLink(pool, { created: ago("31 days"), expires: ago("29 days") });
    expect(await remaining(pool)).toEqual([a, b, c, d, e, f, g, h, i].sort());

    await deleteEndedOneTimeLinks(db);
    expect(await remaining(pool)).toEqual([d, e, f, i].sort());
  });

  it("skip locked: ended rows locked by another transaction are skipped, cleanup doesn't wait for the lock and deletes the rest; they are deleted only on a run after the lock is released", async () => {
    const { db, pool } = await freshDb();
    const old = { created: "now() - interval '40 days'", expires: "now() - interval '39 days'" };
    const a = await insertLink(pool, old);
    await insertLink(pool, old);
    const holder = await pool.connect();
    let first: Promise<void> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from one_time_links where id = $1 for update", [a]);
      first = deleteEndedOneTimeLinks(db);
      expect(await waitForBlockedOrSettled(pool, first)).toBe("settled");
      await first;
      expect(await remaining(pool)).toEqual([a]);
    } finally {
      await holder.query("commit");
      holder.release();
      await first?.catch(() => {});
    }
    await deleteEndedOneTimeLinks(db);
    expect(await remaining(pool)).toEqual([]);
  });
});
