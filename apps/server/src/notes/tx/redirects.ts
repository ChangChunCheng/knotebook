// Transaction-only: moves and transfers rewrite a slug and write redirects in one transaction. Expired rows are purged first (lazy cleanup), then upsert (latest write wins, `expires_at = now() + 1 month`).
import { sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteRedirects } from "../../db/schema.js";

export async function recordRedirectsInTx(tx: Tx, paths: readonly string[], noteId: string): Promise<void> {
  await tx.delete(noteRedirects).where(sql`${noteRedirects.expiresAt} <= now()`);
  if (paths.length === 0) return;
  await tx
    .insert(noteRedirects)
    .values(paths.map(oldPath => ({ oldPath, noteId, expiresAt: sql`now() + interval '1 month'` })))
    .onConflictDoUpdate({
      target: noteRedirects.oldPath,
      set: { noteId, expiresAt: sql`now() + interval '1 month'`, createdAt: sql`now()` },
    });
}
