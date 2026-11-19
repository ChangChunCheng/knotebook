import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { apiTokens, transferTokens } from "../../db/schema.js";
import type { BulkAccess, BulkRange } from "../transfer-token.js";

export interface IssueBulkTransferTokenInput {
  tokenHash: string;
  parentTokenId: string;
  access: BulkAccess;
  /** Ids are lowercase (the caller normalizes). */
  range: BulkRange;
  maxActive: number;
  ttlMinutes: number;
}

/** Tests only. `beforeLock` holds no lock, so a test can delete the parent to produce `revoked`; `afterCount` runs after the count, before the INSERT. */
export interface IssueBulkTransferTokenSeam {
  beforeLock?: () => Promise<void>;
  afterCount?: () => Promise<void>;
}

export type IssueBulkTransferTokenResult = { kind: "issued"; id: string; expiresAt: Date } | { kind: "revoked" } | { kind: "too_many_active" };

/**
 * Same shape as `issueTransferTokenInTx`: locking the parent serializes issuance so the count can't read 2 on both sides; 0 rows means the
 * parent was revoked after authentication. Counts only the parent's unexpired bulk tokens. `expires_at = least(now() + ttl, parent expiry)`.
 * A parent expiring exactly at `now()` hits `transfer_tokens_expiry_chk`, mapped by the caller outside the transaction.
 */
export async function issueBulkTransferTokenInTx(tx: Tx, input: IssueBulkTransferTokenInput, seam?: IssueBulkTransferTokenSeam): Promise<IssueBulkTransferTokenResult> {
  await seam?.beforeLock?.();
  const [parent] = await tx.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.id, input.parentTokenId)).for("no key update");
  if (parent === undefined) return { kind: "revoked" };

  const [active] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transferTokens)
    .where(and(eq(transferTokens.parentTokenId, input.parentTokenId), eq(transferTokens.purpose, "bulk"), sql`${transferTokens.expiresAt} > now()`));
  if (active!.n >= input.maxActive) return { kind: "too_many_active" };
  await seam?.afterCount?.();

  const [row] = await tx
    .insert(transferTokens)
    .values({
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId,
      purpose: "bulk",
      access: input.access,
      range: input.range,
      expiresAt: sql`least(now() + make_interval(mins => ${input.ttlMinutes}::int), coalesce((select ${apiTokens.accessExpiresAt} from ${apiTokens} where ${apiTokens.id} = ${input.parentTokenId}), 'infinity'::timestamptz))`,
    })
    .returning({ id: transferTokens.id, expiresAt: transferTokens.expiresAt });
  return { kind: "issued", id: row!.id, expiresAt: row!.expiresAt };
}
