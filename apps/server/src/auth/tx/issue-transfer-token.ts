import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { apiTokens, transferTokens } from "../../db/schema.js";
import type { TransferPurpose } from "../transfer-token.js";

export interface IssueTransferTokenInput {
  tokenHash: string;
  parentTokenId: string;
  noteId: string;
  purpose: TransferPurpose;
  maxPendingUploads: number;
}

/** Test seam. `beforeLock` holds no lock, so a test can delete the parent to produce `revoked`; `afterCount` runs after the count (download skips it but still calls) and before the INSERT, so a test can interleave two issuers. */
export interface IssueTransferTokenSeam {
  beforeLock?: () => Promise<void>;
  afterCount?: () => Promise<void>;
}

export type IssueTransferTokenResult =
  | { kind: "issued"; id: string; noteId: string; expiresAt: Date }
  | { kind: "revoked" }
  | { kind: "too_many_pending" };

/**
 * Locking the parent `FOR NO KEY UPDATE` serializes issuance per parent (the count can't read 4 on both sides; compatible with the
 * INSERT's FK `KEY SHARE`) and makes a concurrent revoke wait and cascade the new row afterwards, removing the FK race. 0 rows: revoked
 * after authentication. Only unconsumed, unexpired uploads count, per parent (not per note). A NULL parent expiry (PAT default) means
 * 10 min. Left to the caller: the note FK violation and `transfer_tokens_expiry_chk`.
 */
export async function issueTransferTokenInTx(
  tx: Tx,
  input: IssueTransferTokenInput,
  seam?: IssueTransferTokenSeam
): Promise<IssueTransferTokenResult> {
  await seam?.beforeLock?.();
  const [parent] = await tx
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.id, input.parentTokenId))
    .for("no key update");
  if (parent === undefined) return { kind: "revoked" };

  if (input.purpose === "upload") {
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transferTokens)
      .where(
        and(
          eq(transferTokens.parentTokenId, input.parentTokenId),
          eq(transferTokens.purpose, "upload"),
          isNull(transferTokens.consumedAt),
          sql`${transferTokens.expiresAt} > now()`
        )
      );
    if (pending!.n >= input.maxPendingUploads) return { kind: "too_many_pending" };
  }
  await seam?.afterCount?.();

  const [row] = await tx
    .insert(transferTokens)
    .values({
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId,
      noteId: input.noteId,
      purpose: input.purpose,
      // The parent's expiry comes from the row locked above, not through a JS Date.
      expiresAt: sql`least(now() + interval '10 minutes', coalesce((select ${apiTokens.accessExpiresAt} from ${apiTokens} where ${apiTokens.id} = ${input.parentTokenId}), 'infinity'::timestamptz))`,
    })
    .returning({ id: transferTokens.id, noteId: transferTokens.noteId, expiresAt: transferTokens.expiresAt });
  // Only upload/download are issued here and both carry note_id (CHECK `transfer_tokens_bulk_note_chk`).
  return { kind: "issued", id: row!.id, noteId: row!.noteId!, expiresAt: row!.expiresAt };
}
