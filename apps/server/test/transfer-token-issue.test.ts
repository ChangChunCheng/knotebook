// The MCP layer (scope, role, bucket charging, error mapping, test hooks) is in `mcp-transfer*.test.ts`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { hashToken } from "../src/auth/api-token.js";
import { deleteExpiredTransferTokens } from "../src/auth/transfer-cleanup.js";
import {
  MAX_PENDING_UPLOAD_TOKENS,
  TRANSFER_TOKENS_EXPIRY_CHK,
  TRANSFER_TOKENS_NOTE_FK,
  generateTransferToken,
  type TransferPurpose,
} from "../src/auth/transfer-token.js";
import { issueTransferTokenInTx } from "../src/auth/tx/issue-transfer-token.js";
import { apiTokens, transferTokens } from "../src/db/schema.js";
import { checkViolationConstraint, pgErrorSummary } from "../src/db/pg-errors.js";
import type { Db } from "../src/db/index.js";
import { freshDb } from "./helpers.js";
import { seedNote } from "./group-helpers.js";
import { expireToken, issueDirect, ownerWithPat } from "./transfer-helpers.js";

function issue(db: Db, parentTokenId: string, noteId: string, purpose: TransferPurpose) {
  return db.transaction(tx =>
    issueTransferTokenInTx(tx, {
      tokenHash: hashToken(generateTransferToken()),
      parentTokenId,
      noteId,
      purpose,
      maxPendingUploads: MAX_PENDING_UPLOAD_TOKENS,
    }),
  );
}

/** DB `now()` (epoch ms, may be fractional). Each call is its own transaction, so it is "this moment". */
async function dbNowMs(db: Db): Promise<number> {
  const { rows } = await db.$client.query<{ ms: string }>("select extract(epoch from now()) * 1000 as ms");
  return Number(rows[0]!.ms);
}

describe("issueTransferTokenInTx", () => {
  it("issues one row: noteId is the DB lowercase form (even for uppercase input), expiresAt is about now + 10 minutes", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    // Both bounds use the DB clock (the same `now()` as `expires_at`), unaffected by clock drift between the WSL and Windows hosts.
    const before = await dbNowMs(db);
    const r = await issue(db, o.patId, o.noteId.toUpperCase(), "upload");
    const after = await dbNowMs(db);
    expect(r.kind).toBe("issued");
    if (r.kind !== "issued") return;
    expect(r.noteId).toBe(o.noteId);
    // +-1 ms: node-postgres truncates microseconds to milliseconds, while the DB epoch ms is fractional.
    expect(r.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1);
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(after + 10 * 60_000 + 1);
    expect(await db.select().from(transferTokens)).toHaveLength(1);
  });

  it("parent credential missing -> revoked, zero rows", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    expect(await issue(db, randomUUID(), o.noteId, "download")).toEqual({ kind: "revoked" });
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("parent credential has only 60 seconds left -> expiresAt is cut to the parent's access_expires_at (least)", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const parentExp = new Date(Date.now() + 60_000);
    await db.update(apiTokens).set({ accessExpiresAt: parentExp }).where(eq(apiTokens.id, o.patId));
    const r = await issue(db, o.patId, o.noteId, "download");
    expect(r.kind === "issued" && r.expiresAt.getTime()).toBe(parentExp.getTime());
  });

  it("parent credential already expired -> the INSERT hits transfer_tokens_expiry_chk (23514), the caller treats it as revoked", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    // DB clock with 1 minute of slack (not `Date.now()`: pg in WSL and the Windows host clock can drift by seconds).
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, o.patId));
    const err = await issue(db, o.patId, o.noteId, "upload").then(() => null, (e: unknown) => e);
    expect(checkViolationConstraint(err)).toBe(TRANSFER_TOKENS_EXPIRY_CHK);
  });

  it("note missing -> 23503, constraint name = TRANSFER_TOKENS_NOTE_FK (the caller treats it as note_gone)", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const err = await issue(db, o.patId, randomUUID(), "upload").then(() => null, (e: unknown) => e);
    expect(pgErrorSummary(err)).toEqual({ code: "23503", constraint: TRANSFER_TOKENS_NOTE_FK });
  });
});

describe("cap on unconsumed upload tokens", () => {
  it("after 5 unconsumed uploads from one parent credential the 6th is too_many_pending; download is not limited; another parent credential is unaffected", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
    expect((await issue(db, o.patId, o.noteId, "download")).kind).toBe("issued");
    const other = await ownerWithPat(db);
    expect((await issue(db, other.patId, other.noteId, "upload")).kind).toBe("issued");
  });

  it("5 downloads issued first, uploads can still be issued - the count only covers purpose='upload'", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) expect((await issue(db, o.patId, o.noteId, "download")).kind).toBe("issued");
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
  });

  it("5 spread over 5 different notes still count as full - the cap is per parent credential, not per note", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) {
      const n = await seedNote(db, { ownerId: o.userId });
      expect((await issue(db, o.patId, n.id, "upload")).kind).toBe("issued");
    }
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
  });

  it("using one or expiring one frees a slot", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await issueDirect(db, o.patId, o.noteId, "upload")).id);
    await db.update(transferTokens).set({ consumedAt: sql`now()` }).where(eq(transferTokens.id, ids[0]!));
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
    await expireToken(db, ids[1]!);
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
  });
});

describe("deleteExpiredTransferTokens", () => {
  it("only expired rows are deleted", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const live = await issueDirect(db, o.patId, o.noteId, "download");
    const dead = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, dead.id);
    await deleteExpiredTransferTokens(db);
    const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
    expect(ids).toEqual([live.id]);
  });

  it("skip locked: expired rows locked by another transaction are skipped, cleanup does not wait for the lock, the rest are deleted", async () => {
    const { db, pool } = await freshDb();
    const o = await ownerWithPat(db);
    const held = await issueDirect(db, o.patId, o.noteId, "download");
    const other = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, held.id);
    await expireToken(db, other.id);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from transfer_tokens where id = $1 for update", [held.id]);
      const outcome = await Promise.race([
        deleteExpiredTransferTokens(db).then(() => "done" as const),
        new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 3_000)),
      ]);
      expect(outcome).toBe("done");
      const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
      expect(ids).toEqual([held.id]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});
