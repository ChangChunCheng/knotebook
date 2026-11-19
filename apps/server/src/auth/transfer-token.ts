import { randomBytes } from "node:crypto";

/** Deliberately not an extension of `knb_` (4th char `t`), so transfer tokens fail `isAccessTokenShape` without a DB lookup; see `test/unit/transfer-token.test.ts`. */
export const TRANSFER_TOKEN_PREFIX = "knbt_";

/** Cap on unconsumed, unexpired upload tokens per parent (downloads write nothing); a separate thing from the `tokenWrite` rate limit. Tokens rejected before consumption (403/429/409 space full) keep their slot until expiry. */
export const MAX_PENDING_UPLOAD_TOKENS = 5;

export type TransferPurpose = "upload" | "download";

/** Cap on unexpired bulk tokens per parent (upload/download don't count). The "3" in `TOO_MANY_BULK_TOKENS_MESSAGE` is a hardcoded literal; `bulk-transfer-strings.test.ts` keeps them equal. */
export const MAX_ACTIVE_BULK_TOKENS = 3;

export const BULK_TRANSFER_TTL_MINUTES = 30;

export type BulkAccess = "read" | "write";

/** Ids are lowercase; the range is recomputed on every use. */
export type BulkRange =
  | { kind: "all" }
  | { kind: "personal" }
  | { kind: "shared" }
  | { kind: "group"; groupId: string }
  | { kind: "folder"; folderId: string };

export function generateTransferToken(): string {
  return TRANSFER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function isTransferTokenShape(token: string): boolean {
  return token.startsWith(TRANSFER_TOKEN_PREFIX);
}

/** Expected DB errors of the issue transaction, mapped by constraint name outside it: note FK (23503: note deleted after `resolveNoteAccess`, becomes not_found), expiry CHECK (23514: parent expired exactly at `now()`, treated as revoked). Names are copied from the migration SQL (drizzle-generated) and pinned by tests. */
export const TRANSFER_TOKENS_NOTE_FK = "transfer_tokens_note_id_notes_id_fk";
export const TRANSFER_TOKENS_EXPIRY_CHK = "transfer_tokens_expiry_chk";
