import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { userIdentities, users } from "../src/db/schema.js";
import { backfillLegacyOidcIdentities } from "../src/auth/legacy-identities.js";

function captureLogger(): { logger: pino.Logger; lines: () => Array<{ level: number; msg: string }> } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  return { logger: pino({ level: "info" }, stream), lines: () => chunks.join("").split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}

describe("backfillLegacyOidcIdentities (#187)", () => {
  it("users.oidc_* written by old code (rollback period) -> backfilled into an identity; idempotent; no warning", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a] = await db.insert(users).values({ email: "a@x", displayName: "A" }).returning();
    // Raw SQL simulates the old code: only old code writes users.oidc_* (new code always goes through user_identities).
    await pool.query(`update users set oidc_issuer = 'https://idp.example', oidc_sub = 'sa' where id = $1`, [a!.id]);
    const { logger, lines } = captureLogger();
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 1, conflicts: 0 });
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 0, conflicts: 0 });
    const rows = await db.select().from(userIdentities).where(eq(userIdentities.userId, a!.id));
    expect(rows.map(r => [r.issuer, r.sub])).toEqual([["https://idp.example", "sa"]]);
    expect(lines().filter(l => l.level === 40)).toHaveLength(0);
  });

  it("legacy column pointing at an identity already owned by someone else -> skipped without changing data, one warning line (users_oidc_idx is unique, so \"someone else\" can only be on the user_identities side)", async () => {
    const { db } = await buildTestApp();
    const [a] = await db.insert(users).values({ email: "a@x", displayName: "A" }).returning();
    const [b] = await db.insert(users).values({ email: "b@x", displayName: "B" }).returning();
    await db.$client.query(`update users set oidc_issuer = 'https://idp.example', oidc_sub = 'sa' where id = $1`, [a!.id]);
    await db.insert(userIdentities).values({ userId: b!.id, issuer: "https://idp.example", sub: "sa" });
    const { logger, lines } = captureLogger();
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 0, conflicts: 1 });
    expect(await db.select().from(userIdentities).where(eq(userIdentities.userId, a!.id))).toHaveLength(0);
    const warns = lines().filter(l => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain("belongs to another account");
  });
});
