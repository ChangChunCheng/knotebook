import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";

export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Quota only: `kind='oauth' OR` because refresh never expires. Never use it as an auth predicate (`auth/bearer.ts`).
 * `excludeClientId` excludes the row this authorization replaces, or re-authorizing the same client at the cap gets 409
 * (`/oauth/token` deletes first, then counts: keep both in step). Soft quota (not a security boundary): no lock, so concurrent creates
 * may briefly exceed `apiTokensPerUser`.
 */
export async function countBillableGrants(db: DbOrTx, userId: string, excludeClientId?: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        sql`(${apiTokens.kind} = 'oauth' or ${apiTokens.accessExpiresAt} is null or ${apiTokens.accessExpiresAt} > now())`,
        excludeClientId === undefined
          ? undefined
          : sql`not (${apiTokens.kind} = 'oauth' and ${apiTokens.clientId} = ${excludeClientId})`
      )
    );
  return row?.count ?? 0;
}
