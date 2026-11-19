import { sql } from "drizzle-orm";

/** Single clock for `notes.updated_at` (#142): the DB's `now()`. The reduced-precision argument and `list_notes` gap reasoning in `mcp/queries.ts` and the pagination sentence in docs/known-limitations.md assume every `updated_at` comes from it; shared by PATCH and `patchSlugInTx`; don't use `new Date()`. */
export const UPDATED_AT_NOW = sql`now()`;
