import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";

/** No scheduler: opportunistic, fire-and-forget after a transfer token is issued (`create_transfer_token` and `open_notes_as_files`). `for update skip locked` is load-bearing: parent revoke, OAuth cleanup and note-delete cascades delete the same expired rows in a different lock order (40P01 would pick the user-facing side as victim); skipped rows are being cascaded away. Guard: the skip locked case in `transfer-token-issue.test.ts`. */
export async function deleteExpiredTransferTokens(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${transferTokens} where ${transferTokens.id} in (select ${transferTokens.id} from ${transferTokens} where ${transferTokens.expiresAt} < now() for update skip locked)`
  );
}
