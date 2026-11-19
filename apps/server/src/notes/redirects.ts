// Keys are normalized full paths; group ids lowercase (a uuid column compares case-insensitively, string comparison here doesn't).
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { noteRedirects } from "../db/schema.js";

export function userNotePath(handle: string, slug: string): string {
  return `/n/${handle}/${slug}`;
}

export function groupNotePath(groupId: string, slug: string): string {
  return `/g/${groupId.toLowerCase()}/${slug}`;
}

/** The expired-row delete carries `expires_at <= now()` so a row renewed concurrently (e.g. by a move) isn't deleted; uses DB `now()` like the write side. Resolves paths only, no authorization. */
export async function lookupRedirect(db: DbOrTx, oldPath: string): Promise<string | null> {
  const [row] = await db
    .select({ noteId: noteRedirects.noteId, live: sql<boolean>`${noteRedirects.expiresAt} > now()` })
    .from(noteRedirects)
    .where(eq(noteRedirects.oldPath, oldPath))
    .limit(1);
  if (!row) return null;
  if (row.live) return row.noteId;
  await db.delete(noteRedirects).where(and(eq(noteRedirects.oldPath, oldPath), sql`${noteRedirects.expiresAt} <= now()`));
  return null;
}
