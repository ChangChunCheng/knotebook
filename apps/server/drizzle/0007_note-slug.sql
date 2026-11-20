-- Hand-edited from the generated output, whose one-statement form would apply a random default to existing rows before SET NOT NULL,
-- losing the title-derived auto slugs. Do not reorder: the snapshot UPDATE must run before the trigger is created (the trigger would
-- raise on the snapshot UPDATE itself, since that UPDATE sets legacy_slug), and the old global unique index must be dropped before the backfill (a second owner's identical
-- title would violate it). The snapshot describes the final state, so this edit doesn't affect it.
-- No commit statement or concurrent-index syntax in this file: drizzle runs the whole migration in one transaction.
-- slug_is_custom is added without NOT NULL/DEFAULT because the snapshot UPDATE computes it per row.
ALTER TABLE "notes" ADD COLUMN "slug_is_custom" boolean;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "prev_slug" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "legacy_slug" text;--> statement-breakpoint
UPDATE "notes" SET "slug_is_custom" = ("slug" IS NOT NULL), "legacy_slug" = "slug";--> statement-breakpoint
DROP INDEX "notes_slug_idx";--> statement-breakpoint
-- The SQL backfill handles ASCII only: PG regex has no \p{L}\p{M} and glibc lower() diverges from JS on cases like İ, so JS semantics
-- are not chased. A title with any non-ASCII character always becomes 'untitled' (plus the dedupe suffix); a pure-ASCII title must give
-- exactly what shared's autoSlugFromTitle gives (migrate.test.ts compares the SQL and TS implementations).
-- Pipeline order as in TS: lower, runs of non-[a-z0-9] to '-', trim dashes, cut to 60 and trim trailing dash, then empty/'new'/uuid-shaped
-- (whole string or a -<uuid> tail) -> 'untitled'. These checks run after the cut, as in TS (validateSlug receives the already-cut slug).
-- Dedupe with WHILE EXISTS within the owner (the predicate excludes the row itself; covers existing custom slugs and already-backfilled
-- rows); after 100 tries falls back to 'untitled-'+uuid8. Rows go in (created_at, id) order so the result is deterministic
-- (migrate.test.ts pins this with a fixture whose physical insert order differs from created_at).
DO $$
DECLARE
  r RECORD;
  base text;
  cand text;
  n int;
BEGIN
  FOR r IN SELECT id, owner_id, title FROM notes WHERE slug IS NULL ORDER BY created_at, id LOOP
    IF r.title ~ '[^[:ascii:]]' THEN
      base := 'untitled';
    ELSE
      base := lower(r.title);
      base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
      base := regexp_replace(base, '^-+|-+$', '', 'g');
      base := left(base, 60);
      base := regexp_replace(base, '-+$', '');
      IF base = '' OR base = 'new'
         OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR base ~ '-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        base := 'untitled';
      END IF;
    END IF;

    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM notes WHERE owner_id = r.owner_id AND slug = cand AND id <> r.id) AND n < 100 LOOP
      n := n + 1;
      cand := regexp_replace(left(base, 60 - length('-' || n::text)), '-+$', '') || '-' || n::text;
    END LOOP;
    -- When the loop exits with n < 100, cand is already known to be free; only the cap case needs a recheck.
    IF n >= 100 AND EXISTS (SELECT 1 FROM notes WHERE owner_id = r.owner_id AND slug = cand AND id <> r.id) THEN
      cand := 'untitled-' || substr(r.id::text, 1, 8);
    END IF;

    UPDATE notes SET slug = cand WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
-- NOT NULL only after the backfill; why the slug DEFAULT exists: see schema.ts.
ALTER TABLE "notes" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug" SET DEFAULT 'untitled-' || substr(gen_random_uuid()::text, 1, 8);--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug_is_custom" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug_is_custom" SET DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_owner_slug_idx" ON "notes" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_legacy_slug_idx" ON "notes" USING btree ("legacy_slug") WHERE "notes"."legacy_slug" is not null;--> statement-breakpoint
CREATE INDEX "notes_owner_prev_slug_idx" ON "notes" USING btree ("owner_id","prev_slug") WHERE "notes"."prev_slug" is not null;--> statement-breakpoint
-- Must be the last step: the snapshot UPDATE has to finish first. The WHEN clause keeps ordinary title/slug updates free of function-call cost.
-- Any later maintenance or migration that changes legacy_slug must first DROP TRIGGER "notes_legacy_slug_guard".
CREATE FUNCTION notes_legacy_slug_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'notes.legacy_slug is immutable (DROP TRIGGER notes_legacy_slug_guard first for maintenance)';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER notes_legacy_slug_guard BEFORE UPDATE ON notes FOR EACH ROW
  WHEN (OLD.legacy_slug IS DISTINCT FROM NEW.legacy_slug)
  EXECUTE FUNCTION notes_legacy_slug_guard();
