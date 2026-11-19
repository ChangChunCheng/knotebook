import { and, eq, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { notes } from "../db/schema.js";
import { lookupRedirect } from "./redirects.js";

export interface PathRowSource<Row> {
  /** `cond` includes the caller's `scopeCond`; the `/n/` form filters on `users.handle`, so every implementation must JOIN `users ON users.id = notes.owner_id`. Resolves a path only; no authorization. */
  where(cond: SQL, limit: number): PromiseLike<Row[]>;
  byId(noteId: string): PromiseLike<Row | undefined>;
}

export async function resolveNotePath<Row>(db: DbOrTx, source: PathRowSource<Row>, scopeCond: SQL, slug: string, redirectKey: string): Promise<Row | undefined> {
  const [hit] = await source.where(and(scopeCond, eq(notes.slug, slug))!, 1);
  if (hit) return hit;
  const redirected = await lookupRedirect(db, redirectKey);
  if (redirected !== null) return source.byId(redirected);
  const prevHits = await source.where(and(scopeCond, eq(notes.prevSlug, slug))!, 2);
  return prevHits.length === 1 ? prevHits[0] : undefined;
}
