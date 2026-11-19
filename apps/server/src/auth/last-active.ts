import { sql } from "drizzle-orm";
import { LAST_ACTIVE_WRITE_INTERVAL_MS } from "@knotebook/shared";
import type { Db } from "../db/index.js";

const DEFAULT_MAX_ENTRIES = 10_000;

export interface LastActiveLogger {
  warn(obj: object, msg: string): void;
}

export interface LastActiveTrackerOptions {
  maxEntries?: number;
  now?: () => number;
}

/**
 * Two throttle layers per user: an in-process table of the last attempt (not success, so failures and SKIP LOCKED skips
 * wait out the interval too and a DB outage doesn't add a query per request; this is the main filter since every typing change calls
 * it), and the SQL predicate as backstop across app processes. Never waits for a lock (`SKIP LOCKED`) and never rejects (errors only
 * warn), so REST may await it and collab needn't. Session activity only (bearer tokens track their own). Not in `UserDto`, so no gate invalidate.
 */
export class LastActiveTracker {
  private readonly lastAttempt = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly log: LastActiveLogger,
    options: LastActiveTrackerOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.lastAttempt.size;
  }

  lastAttemptAt(userId: string): number | undefined {
    return this.lastAttempt.get(userId);
  }

  async touch(userId: string): Promise<void> {
    try {
      const now = this.now();
      const prev = this.lastAttempt.get(userId);
      if (prev !== undefined && now - prev < LAST_ACTIVE_WRITE_INTERVAL_MS) return;
      if (prev === undefined && this.lastAttempt.size >= this.maxEntries) this.prune(now);
      this.lastAttempt.set(userId, now);
      await this.db.execute(sql`
        update users set last_active_at = now()
         where id = (select id from users
                      where id = ${userId}
                        and (last_active_at is null or last_active_at < now() - make_interval(secs => ${LAST_ACTIVE_WRITE_INTERVAL_MS / 1000}))
                      for no key update skip locked)`);
    } catch (err) {
      this.log.warn({ err, userId }, "last_active_at 寫入失敗（不影響請求）");
    }
  }

  /** Clearing everything when still full costs at most a few extra UPDATEs that the SQL predicate rejects. */
  private prune(now: number): void {
    for (const [id, at] of this.lastAttempt) {
      if (now - at >= LAST_ACTIVE_WRITE_INTERVAL_MS) this.lastAttempt.delete(id);
    }
    if (this.lastAttempt.size >= this.maxEntries) this.lastAttempt.clear();
  }
}
