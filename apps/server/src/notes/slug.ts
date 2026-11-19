import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { autoSlugFromTitle, extractRefUuid, normalizeSlug, validateSlug } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import { notes } from "../db/schema.js";

function slugErrorMessage(reason: NonNullable<ReturnType<typeof validateSlug>>): string {
  switch (reason) {
    case "length":
      return "The URL slug must be 1 to 100 characters.";
    case "charset":
      return "The URL slug can only contain letters, digits and hyphens (-).";
    case "dash":
      return "The URL slug can't start or end with a hyphen or have two hyphens in a row.";
    case "reserved":
      return "That URL slug is reserved by the system.";
    case "uuid_like":
      return "The URL slug can't look like a UUID, because it would be confused with note ids.";
  }
}

export type SlugValidationResult = { ok: true; value: string } | { ok: false; message: string };

export function prepareSlugForPatch(raw: string): SlugValidationResult {
  const normalized = normalizeSlug(raw);
  const reason = validateSlug(normalized);
  if (reason) {
    return { ok: false, message: slugErrorMessage(reason) };
  }
  return { ok: true, value: normalized };
}

// Probing is O(same-prefix count) index queries, and both title PATCH and note creation are unthrottled (cookie `POST /api/notes` has no per-user limiter), so a bound is required; beyond it fall back to `untitled-<uuid8>`.
const AUTO_SLUG_PROBE_LIMIT = 20;

// 1..5 re-probes, then `fallbackAutoSlug()`; a further collision (~2^-32) surfaces. Shared by PATCH (UPDATE retry) and create (INSERT retry): separate hard-coded 5s could drift with no test failing.
export const MAX_AUTO_SLUG_RETRIES = 5;

export function fallbackAutoSlug(): string {
  return `untitled-${randomUUID().slice(0, 8)}`;
}

/** Personal notes dedupe per owner (`notes_owner_slug_idx`), group notes per group (`notes_group_slug_idx`); the two unique indexes don't collide with each other: group notes have `owner_id` NULL. */
export type SlugScope = { ownerId: string } | { groupId: string };

export function isSlugUniqueViolation(err: unknown): boolean {
  const c = uniqueViolationConstraint(err);
  return c === "notes_owner_slug_idx" || c === "notes_group_slug_idx";
}

/** n=1 returns the base itself; n≥2 re-truncates the base by code point (CJK isn't cut in half) so the total ≤ 60, drops a trailing dash (no `--N`), then appends `-N`. Same as the 0007 backfill SQL. */
export function nextSlugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const trimmed = Array.from(base).slice(0, 60 - suffix.length).join("").replace(/-+$/, "");
  return `${trimmed}${suffix}`;
}

/**
 * The predicate must exclude the row itself (`id <> noteId`), otherwise a title tweak that leaves the auto slug unchanged would find itself occupying it and flip between `meeting` and `meeting-2`. `excludeNoteId === null` means the row doesn't exist yet (create): `and()` drops the undefined predicate. This is an availability probe, not the uniqueness arbiter: the unique indexes are, and callers retry on collision (shared `MAX_AUTO_SLUG_RETRIES`).
 */
export async function probeUniqueSlug(db: DbOrTx, scope: SlugScope, excludeNoteId: string | null, base: string): Promise<string> {
  for (let n = 1; n <= AUTO_SLUG_PROBE_LIMIT; n++) {
    const cand = nextSlugCandidate(base, n);
    const [hit] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          "groupId" in scope ? eq(notes.groupId, scope.groupId) : eq(notes.ownerId, scope.ownerId),
          eq(notes.slug, cand),
          excludeNoteId === null ? undefined : ne(notes.id, excludeNoteId),
        ),
      )
      .limit(1);
    if (!hit) return cand;
  }
  return fallbackAutoSlug();
}

export async function deriveUniqueAutoSlug(db: DbOrTx, scope: SlugScope, noteId: string | null, title: string): Promise<string> {
  return probeUniqueSlug(db, scope, noteId, autoSlugFromTitle(title));
}

/**
 * Looks up `notes.legacy_slug` (frozen at 0007, globally unique, immutable via trigger), deliberately not the current `notes.slug`: slugs are per-user unique, so a global lookup has no deterministic answer, and old-form links stay frozen to 0007's world. Then falls back to the uuid in the ref (bare or `<vanity>-<uuid>`), so pre-0007 links resolve forever; A's legacy slug beats B's later identical custom slug by design (hijack test). Resolves ref → id only, no authorization; null always maps to 404 (anti-enumeration).
 */
export async function resolveNoteIdFromRef(db: DbOrTx, ref: string): Promise<string | null> {
  const normalized = normalizeSlug(ref);
  const [byLegacy] = await db.select({ id: notes.id }).from(notes).where(eq(notes.legacySlug, normalized)).limit(1);
  if (byLegacy) return byLegacy.id;
  return extractRefUuid(ref);
}
