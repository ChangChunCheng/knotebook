import { pgErrorSummary } from "../db/pg-errors.js";

/**
 * For unexpected DB errors on ciphertext writes. drizzle's `DrizzleQueryError` puts the SQL and `params` in `message`, and the global
 * handler hands the whole err to pino, so they would be logged; a pg error's `detail` ("Failing row contains ...") likewise. Callers handle
 * errors they know (`TxAbort`, known constraint names) and `throw redactDbError(...)` for the rest. Only `{ code, constraint, context }` is
 * logged, plus `name` for non-pg errors (no SQLSTATE), never the message. The returned Error has no `cause` (the global handler would log it
 * with the params) and still gives a 500.
 */
export function redactDbError(log: { error(obj: object, msg: string): void }, err: unknown, context: string): Error {
  const { code, constraint } = pgErrorSummary(err);
  const summary = code === null ? { code, constraint, name: err instanceof Error ? err.name : typeof err } : { code, constraint };
  log.error({ ...summary, context }, `${context}時發生非預期的資料庫錯誤（錯誤本體已遮蔽）`);
  return new Error(`${context}：資料庫錯誤（code ${code ?? "unknown"}；細節已遮蔽）`);
}
