/** DB errors log only `pgErrorSummary`: drizzle's message carries the params. */
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/index.js";
import { transferBases } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";

export type TransferBaseInsert = typeof transferBases.$inferInsert;

/** Rows unused for 30 days are deleted; each (user, note) keeps the newest 10. */
export const BASE_RETENTION_DAYS = 30;
export const BASES_PER_NOTE = 10;

export async function insertBases(db: Db, log: FastifyBaseLogger, rows: TransferBaseInsert[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(transferBases).values(rows);
  } catch (err) {
    log.warn({ ...pgErrorSummary(err), rows: rows.length }, "寫入 transfer 基底失敗");
    throw new Error("insertBases failed");
  }
}

/** `for update skip locked` on both statements; a window function can't share a statement with FOR UPDATE, so the per-note trim selects keys first. */
export function pruneBases(db: Db, log: FastifyBaseLogger, userId: string, noteIds: string[]): void {
  void (async () => {
    await db.execute(
      sql`delete from ${transferBases} where ${transferBases.key} in (select ${transferBases.key} from ${transferBases} where ${transferBases.lastUsedAt} < now() - make_interval(days => ${BASE_RETENTION_DAYS}::int) for update skip locked)`,
    );
    if (noteIds.length === 0) return;
    const ids = sql.join(noteIds.map(id => sql`${id}::uuid`), sql`, `);
    const extra = await db.execute<{ key: string }>(
      sql`select t.key from (select ${transferBases.key} as key, row_number() over (partition by ${transferBases.noteId} order by ${transferBases.createdAt} desc, ${transferBases.key} desc) as rn from ${transferBases} where ${transferBases.userId} = ${userId} and ${transferBases.noteId} in (${ids})) t where t.rn > ${BASES_PER_NOTE}`,
    );
    const keys = extra.rows.map(r => r.key);
    if (keys.length === 0) return;
    const ks = sql.join(keys.map(k => sql`${k}`), sql`, `);
    await db.execute(
      sql`delete from ${transferBases} where ${transferBases.key} in (select ${transferBases.key} from ${transferBases} where ${transferBases.key} in (${ks}) for update skip locked)`,
    );
  })().catch((err: unknown) => {
    log.warn({ ...pgErrorSummary(err) }, "清理 transfer 基底失敗");
  });
}
