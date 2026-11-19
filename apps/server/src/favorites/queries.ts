import { and, desc, eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { FavoriteDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { noteFavorites, notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";

/** Rows for notes that lost access or went to the trash aren't deleted: they just don't show and return on restore with their original time. Same-millisecond favorites order by note id desc for a stable order. `favoritedAt` is a correlated subquery (the alias `f` isn't visible outside `exists`); raw `sql` timestamps need `.mapWith`. */
export async function listFavorites(db: DbOrTx, userId: string): Promise<FavoriteDto[]> {
  const favoritedAt = sql<Date>`(select f.created_at from ${noteFavorites} f where f.user_id = ${userId} and f.note_id = ${notes.id})`
    .mapWith(noteFavorites.createdAt)
    .as("favorited_at");
  const { owned, shared, grouped } = visibleNoteBranches(db, userId, {
    extraWhere: sql`exists (select 1 from ${noteFavorites} f where f.user_id = ${userId} and f.note_id = ${notes.id})`,
    extra: { favoritedAt },
  });
  const rows = await unionAll(owned, shared, grouped).orderBy(desc(favoritedAt), desc(notes.id));
  return rows.map(row => ({ noteId: row.id, favoritedAt: row.favoritedAt.toISOString() }));
}

/** The caller has authorized and `noteId` is UUID-checked and lowercased. Not `do nothing` then re-read: a removal from another tab in between would read 0 rows. A note deleted after authorization hits the FK: `"gone"` (route 404). */
export async function addFavorite(db: DbOrTx, input: { userId: string; noteId: string }): Promise<FavoriteDto | "gone"> {
  try {
    const [row] = await db
      .insert(noteFavorites)
      // Written out although it equals the column default: the returned ISO string then matches the stored value used by list order and the web's optimistic order.
      .values({ userId: input.userId, noteId: input.noteId, createdAt: sql`date_trunc('milliseconds', now())` })
      // `set createdAt = createdAt` makes `returning` yield the existing row: idempotent, the original time is kept.
      .onConflictDoUpdate({ target: [noteFavorites.userId, noteFavorites.noteId], set: { createdAt: sql`${noteFavorites.createdAt}` } })
      .returning({ createdAt: noteFavorites.createdAt });
    return { noteId: input.noteId, favoritedAt: row!.createdAt.toISOString() };
  } catch (err) {
    if (isForeignKeyViolation(err)) return "gone";
    throw err;
  }
}

export async function removeFavorite(db: DbOrTx, input: { userId: string; noteId: string }): Promise<void> {
  await db.delete(noteFavorites).where(and(eq(noteFavorites.userId, input.userId), eq(noteFavorites.noteId, input.noteId)));
}
