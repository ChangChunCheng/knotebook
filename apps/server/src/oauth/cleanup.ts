import { and, eq, sql } from "drizzle-orm";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../db/schema.js";

/** No scheduler: runs opportunistically on OAuth and PAT-creation requests (docs/known-limitations.md). The target predicates are unindexed on purpose: the tables stay small and the triggers are rate-limited. */
export async function runOauthCleanup(db: Db): Promise<void> {
  // last_used_at moves on every successful Bearer check, so a client in daily use survives.
  await db.delete(oauthClients).where(sql`${oauthClients.lastUsedAt} < now() - make_interval(days => ${OAUTH_APP_IDLE_DAYS})`);

  await db.delete(oauthClients).where(
    // Zombie clients: older than 24h and never produced a grant or code (table flooding; a normal client yields a code within seconds).
    sql`${oauthClients.createdAt} < now() - interval '24 hours'
        and not exists (select 1 from ${apiTokens} where ${apiTokens.clientId} = ${oauthClients.clientId})
        and not exists (select 1 from ${oauthCodes} where ${oauthCodes.clientId} = ${oauthClients.clientId})`
  );

  // After the zombie delete, so a client whose only code just expired goes next run (self-healing; don't reorder).
  await db.delete(oauthRequests).where(sql`${oauthRequests.expiresAt} < now()`);
  await db.delete(oauthCodes).where(sql`${oauthCodes.expiresAt} < now()`);

  // Only `kind='pat'`: an oauth grant's access expiring doesn't revoke it (refresh never expires); those converge only via the idle-client delete and revocation.
  await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.kind, "pat"), sql`${apiTokens.accessExpiresAt} < now() - interval '30 days'`));
}
