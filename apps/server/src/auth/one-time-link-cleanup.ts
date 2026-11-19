import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { oneTimeLinks } from "../db/schema.js";

/**
 * No scheduler: opportunistic, fire-and-forget after a link is created (failure only `log.warn`). Deletes links ended more than 30 days
 * ago; the end is `coalesce(used_at, revoked_at, expires_at)`. `for update skip locked` is load-bearing: complete, cancel, disable and the
 * user-delete cascade may lock the same row, and skipping locked rows means no wait and no cycle (guard: the skip locked case in
 * `test/one-time-link-cleanup.test.ts`).
 */
export async function deleteEndedOneTimeLinks(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${oneTimeLinks} where ${oneTimeLinks.id} in (select ${oneTimeLinks.id} from ${oneTimeLinks} where coalesce(${oneTimeLinks.usedAt}, ${oneTimeLinks.revokedAt}, ${oneTimeLinks.expiresAt}) < now() - interval '30 days' for update skip locked)`
  );
}
