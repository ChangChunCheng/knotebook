import { and, eq, sql } from "drizzle-orm";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../db/schema.js";

/** No scheduler: runs opportunistically on OAuth use (docs/known-limitations.md). The target predicates are unindexed on purpose: the tables stay small and the triggers are rate-limited. */
export async function runOauthCleanup(db: Db): Promise<void> {
  await db.delete(oauthClients).where(sql`${oauthClients.lastUsedAt} < now() - make_interval(days => ${OAUTH_APP_IDLE_DAYS})`);

  await db.delete(oauthClients).where(
    // Zombie clients: older than 24h and never produced a grant or code (table flooding; a normal client yields a code within seconds). Runs after the idle-client delete, so one whose only code just expired goes next round: self-healing, no reordering needed.
    sql`${oauthClients.createdAt} < now() - interval '24 hours'
        and not exists (select 1 from ${apiTokens} where ${apiTokens.clientId} = ${oauthClients.clientId})
        and not exists (select 1 from ${oauthCodes} where ${oauthCodes.clientId} = ${oauthClients.clientId})`
  );

  await db.delete(oauthRequests).where(sql`${oauthRequests.expiresAt} < now()`);
  await db.delete(oauthCodes).where(sql`${oauthCodes.expiresAt} < now()`);

  // Only `kind='pat'`: an oauth grant's access expiring doesn't revoke it (refresh never expires).
  await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.kind, "pat"), sql`${apiTokens.accessExpiresAt} < now() - interval '30 days'`));
}
