// Logs ids only, never titles; changes nothing: over-limit notes still open and read.
import { gt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { noteStates } from "../db/schema.js";
import type { SiteLimits } from "../site-limits/store.js";

export const OVER_CAP_IDS_LOGGED = 1000;

// Only `index.ts` calls this; `buildApp` doesn't subscribe.
export function watchNotesOverCap(
  siteLimits: SiteLimits,
  db: Db,
  log: { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void },
): () => void {
  return siteLimits.onChange(keys => {
    if (!keys.has("noteMaxBytes")) return;
    void logNotesOverCap(db, siteLimits.get("noteMaxBytes"), log).catch(err => log.error({ err }, "failed to log notes over the size limit"));
  });
}

export async function logNotesOverCap(db: Db, limitBytes: number, log: { info(o: object, m: string): void; warn(o: object, m: string): void }): Promise<{ count: number; noteIds: string[] }> {
  const rows = await db
    .select({ noteId: noteStates.noteId })
    .from(noteStates)
    .where(gt(sql`octet_length(${noteStates.ydoc})`, limitBytes))
    .orderBy(noteStates.noteId);
  const noteIds = rows.map(r => r.noteId);
  if (noteIds.length === 0) log.info({ limitBytes, count: 0 }, "note size limit in effect; no note is over it");
  else log.warn({ limitBytes, count: noteIds.length, noteIds: noteIds.slice(0, OVER_CAP_IDS_LOGGED) }, "notes already over the note size limit (they still open and read; they can't grow)");
  return { count: noteIds.length, noteIds };
}
