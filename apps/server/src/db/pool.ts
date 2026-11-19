import { Pool } from "pg";
import type { AppConfig } from "../config.js";

// The borrow timeout turns a transaction awaiting the same pool into 500s instead of a hang (raising `max` only moves
// the threshold); `pool.on("error")` never sees borrow timeouts. The wait queue is FIFO, so ordinary requests behind stuck ones time out too.
export function createPool(config: Pick<AppConfig, "databaseUrl" | "databasePoolMax" | "databasePoolConnectionTimeoutMs">): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs,
  });
}
