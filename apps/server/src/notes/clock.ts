import { sql } from "drizzle-orm";

/** Single clock for `notes.updated_at` (#142): the DB's `now()`. The `list_notes` pagination reasoning in `mcp/queries.ts` assumes it; don't use `new Date()`. */
export const UPDATED_AT_NOW = sql`now()`;
