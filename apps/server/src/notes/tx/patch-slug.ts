/**
 * Lock the row first, then read: `old_custom` must be the version this UPDATE actually overwrote, which also holds under concurrency (RETURNING with a subquery reads the statement-start snapshot under EPQ and gets it wrong). 0 rows = ownership changed after authorization (e.g. a move), or the row was deleted/trashed → null; the caller rereads to tell 404 from 409.
 * Personal scope with `old_custom` deletes the redirect for the new prev in the same transaction (redirect vs prev: last write wins); group scope doesn't (`/g/` redirects are only written by transfer, which deletes the group in the same transaction).
 * `redirectHandle` comes from the caller: don't query users here (an in-transaction owner-handle lookup deadlocked permanently under concurrency).
 */
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteRedirects, notes } from "../../db/schema.js";
import { UPDATED_AT_NOW } from "../clock.js";
import { userNotePath } from "../redirects.js";

export type SlugWriteScope = { kind: "personal"; ownerId: string } | { kind: "group"; groupId: string };

export type SlugPatchTestHook = (point: "authorized" | "slug-written", ctx: { noteId: string }) => Promise<void>;

export interface PatchSlugInput {
  noteId: string;
  scope: SlugWriteScope;
  set: { title?: string; slug: string; slugIsCustom: boolean };
  redirectHandle: string | null;
}

export async function patchSlugInTx(
  tx: Tx,
  input: PatchSlugInput,
  hook?: SlugPatchTestHook,
): Promise<typeof notes.$inferSelect | null> {
  const scope =
    input.scope.kind === "personal"
      ? and(eq(notes.ownerId, input.scope.ownerId), isNull(notes.groupId))
      : eq(notes.groupId, input.scope.groupId);
  const o = tx.$with("o").as(
    tx
      .select({ id: notes.id, oldCustom: sql<boolean>`${notes.slugIsCustom}`.as("old_custom") })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), scope, isNull(notes.deletedAt)))
      .for("update"),
  );
  const [row] = await tx
    .with(o)
    .update(notes)
    .set({
      updatedAt: UPDATED_AT_NOW,
      ...(input.set.title !== undefined ? { title: input.set.title } : {}),
      slug: input.set.slug,
      slugIsCustom: input.set.slugIsCustom,
      // PG evaluates SET expressions against the OLD row, so the CASE sees the pre-update `slug_is_custom`/`slug`.
      prevSlug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${notes.prevSlug} end`,
    })
    .from(o)
    .where(eq(notes.id, o.id))
    .returning({ ...getTableColumns(notes), oldCustom: o.oldCustom });
  if (!row) return null;
  await hook?.("slug-written", { noteId: input.noteId });
  const { oldCustom, ...updated } = row;
  if (oldCustom && input.scope.kind === "personal" && input.redirectHandle !== null && updated.prevSlug !== null) {
    await tx.delete(noteRedirects).where(eq(noteRedirects.oldPath, userNotePath(input.redirectHandle, updated.prevSlug)));
  }
  return updated;
}
