import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AvatarRef, UserAvatarDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { userAvatars } from "../db/schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readCurrentAvatar(db: DbOrTx, userId: string): Promise<UserAvatarDto | null> {
  const [row] = await db
    .select({ id: userAvatars.id, v: userAvatars.version, pending: sql<boolean>`${userAvatars.displayData} is null` })
    .from(userAvatars)
    .where(and(eq(userAvatars.userId, userId), eq(userAvatars.isCurrent, true)))
    .limit(1);
  return row ?? null;
}

/**
  * Ids go as ONE array parameter (`= any($1::uuid[])`; PostgreSQL allows 65535 per statement and the admin user list can exceed it); the UUID
  * filter makes the cast safe, and empty or all-non-UUID input sends no query. Candidates with no display image yet are excluded (others get
  * 404 for them). Disabled accounts are still returned. No permission check: input must only be ids the endpoint already outputs, or callers
  * could look up anyone's avatar id.
  */
export async function readAvatarRefs(db: DbOrTx, userIds: readonly string[]): Promise<Map<string, AvatarRef>> {
  const ids = [...new Set(userIds)].filter(id => UUID_RE.test(id));
  const out = new Map<string, AvatarRef>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: userAvatars.userId, id: userAvatars.id, v: userAvatars.version })
    .from(userAvatars)
    .where(and(sql`${userAvatars.userId} = any(${sql.param(ids)}::uuid[])`, eq(userAvatars.isCurrent, true), isNotNull(userAvatars.displayData)));
  for (const r of rows) out.set(r.userId, { id: r.id, v: r.v });
  return out;
}
