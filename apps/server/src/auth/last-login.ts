import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/index.js";

/**
  * Called wherever a NEW login session is signed (not when re-signing after a password change or linking while signed in).
  * Outside any transaction, never waits for a lock (`SKIP LOCKED`: a locked `users` row is skipped with a warn, since
  * "SSO login doesn't wait on `users`" outranks recording; the cost is an occasionally missed login under concurrency).
  * Display-only: errors are swallowed here because the OIDC callback's outer catch would turn any exception into
  * `oidc_exchange_failed`. Also writes `last_active_at` (a login is activity; bypasses `LastActiveTracker`'s throttle).
  * Neither column is in `UserDto`, so no gate invalidate.
  */
export async function touchLastLogin(db: Db, userId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const res = await db.execute(
      sql`update users set last_login_at = now(), last_active_at = now() where id = (select id from users where id = ${userId} for no key update skip locked)`,
    );
    if (res.rowCount === 0) log.warn({ userId }, "last_login_at skipped: row locked");
  } catch (err) {
    log.warn({ err, userId }, "last_login_at 寫入失敗（不影響登入）");
  }
}
