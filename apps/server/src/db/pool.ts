import { Pool } from "pg";
import type { AppConfig } from "../config.js";

// The borrow timeout turns a transaction awaiting the same pool into 500s instead of a hang (raising `max` only moves
// the threshold); `pool.on("error")` never sees borrow timeouts: they surface as the error handler's "unhandled error" log.
// The wait queue is FIFO: ordinary requests queued ahead of the stuck borrows may time out too; later arrivals wait at most one timeout.
export function createPool(config: Pick<AppConfig, "databaseUrl" | "databasePoolMax" | "databasePoolConnectionTimeoutMs">): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs,
  });
}
