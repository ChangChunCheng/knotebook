// Shared by move, copy (`insertNoteWithAutoSlug`'s `inTx` mode) and delete-group transfer. Each round writes in a savepoint (drizzle nested tx), so hitting a slug unique index rolls back only the savepoint and the outer transaction stays usable; after `MAX_AUTO_SLUG_RETRIES` rounds it writes `fallbackAutoSlug()` without probing. Other errors (other 23505, FK 23503) are rethrown.
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { MAX_AUTO_SLUG_RETRIES, fallbackAutoSlug, isSlugUniqueViolation, probeUniqueSlug, type SlugScope } from "../slug.js";

export interface WriteSlugOptions {
  excludeNoteId?: string;
  beforeWrite?: (candidate: string) => void | Promise<void>;
}

export async function writeSlugInTx(
  tx: Tx,
  scope: SlugScope,
  source: { base: string } | { title: string },
  write: (slug: string) => Promise<void>,
  opts: WriteSlugOptions = {},
): Promise<string> {
  const base = "base" in source ? source.base : autoSlugFromTitle(source.title);
  for (let attempt = 1; ; attempt++) {
    const slug = attempt > MAX_AUTO_SLUG_RETRIES ? fallbackAutoSlug() : await probeUniqueSlug(tx, scope, opts.excludeNoteId ?? null, base);
    await opts.beforeWrite?.(slug);
    try {
      await tx.transaction(async () => {
        await write(slug);
      });
      return slug;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
}
