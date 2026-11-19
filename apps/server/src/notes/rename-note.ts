/**
 * No transaction: a single UPDATE. Authorization is the caller's job. The expect* checks (#381; MCP `if_match`, bulk write-back `expectTitle`) are two layers: a fingerprint check after the pre-read, and a conditional UPDATE (`WHERE title = pre.title`; pg's row lock + EvalPlanQual make a rename committed in between yield 0 rows). Both are needed: without the first, the pre-read could be someone else's new title and the WHERE would still match; without the second there's a TOCTOU window. REST PATCH passes neither (last-write-wins). ABA (changed away and back) counts as unchanged. `expectTitleFingerprint` is `fingerprintOf` of the full title, not the truncated display string. Guards: `test/notes-slug.test.ts` statement shape, `test/mcp-rename.test.ts`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { UPDATED_AT_NOW } from "./clock.js";
import { fingerprintOf } from "./editing/fingerprint.js";
import type { NoteAccess } from "./service.js";
import { deriveUniqueAutoSlug, fallbackAutoSlug, isSlugUniqueViolation, MAX_AUTO_SLUG_RETRIES, type SlugScope } from "./slug.js";

export type RenameOutcome =
  | { kind: "renamed"; row: typeof notes.$inferSelect }
  | { kind: "gone" }
  | { kind: "ownership_changed" }
  | { kind: "title_changed" };

export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string; expectTitleFingerprint?: string; expectTitle?: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<RenameOutcome> {
  const { noteId: id, access, title, expectTitleFingerprint: expect, expectTitle } = input;
  const guarded = expect !== undefined || expectTitle !== undefined;
  const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
  const [pre] = await db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!pre) return { kind: "gone" };
  if (expect !== undefined && fingerprintOf(pre.title) !== expect) return { kind: "title_changed" };
  if (expectTitle !== undefined && pre.title !== expectTitle) return { kind: "title_changed" };
  const needsAuto = !pre.slugIsCustom;

  let updated: typeof notes.$inferSelect | undefined;
  for (let attempt = 1; ; attempt++) {
    // custom=true: the CASE keeps the current slug, so an unprobed candidate is fine; if a concurrent flip back to auto lands, only a real index collision re-probes.
    let auto: string;
    if (attempt > MAX_AUTO_SLUG_RETRIES) auto = fallbackAutoSlug();
    else if (needsAuto || attempt > 1) auto = await deriveUniqueAutoSlug(db, slugScope, id, title);
    else auto = autoSlugFromTitle(title);
    await hook?.(auto);
    try {
      [updated] = await db
        .update(notes)
        .set({ updatedAt: UPDATED_AT_NOW, title, slug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${auto} end` })
        .where(
          and(
            eq(notes.id, id),
            access.groupId !== null ? eq(notes.groupId, access.groupId) : and(eq(notes.ownerId, access.ownerId!), isNull(notes.groupId)),
            isNull(notes.deletedAt),
            guarded ? eq(notes.title, pre.title) : undefined,
          ),
        )
        .returning();
      break;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
  if (updated) return { kind: "renamed", row: updated };
  const [still] = await db.select({ id: notes.id, title: notes.title }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!still) return { kind: "gone" };
  // A changed title takes priority over `ownership_changed` (the re-read sees both).
  if (guarded && still.title !== pre.title) return { kind: "title_changed" };
  return { kind: "ownership_changed" };
}
