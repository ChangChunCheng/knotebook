CREATE TABLE "handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "handles_handle_chk" CHECK ("handles"."handle" ~ '^[a-z0-9-]{1,32}$'),
	CONSTRAINT "handles_state_chk" CHECK ("handles"."state" in ('live','released')),
	CONSTRAINT "handles_released_at_chk" CHECK (("handles"."state" = 'released') = ("handles"."released_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "handles_user_idx" ON "handles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
-- Hand-edited from the generated output (add nullable column, backfill, SET NOT NULL/DEFAULT, ADD CONSTRAINT): the generated
-- one-statement form would apply the random default to existing rows, losing the email-derived handle. The snapshot describes the
-- final state, so this edit doesn't affect it.
-- Per-row backfill in (created_at, id) order, so it is deterministic. Candidate = ASCII-only SQL simplification of the email local part:
-- lower, runs of non-[a-z0-9] to '-', trim leading/trailing dashes, empty or uuid-shaped -> user-<uuid8>, cut to 30, trim trailing dash.
-- WHILE EXISTS(handles) appends a -N suffix (base re-cut so the total stays <= 32; after 100 tries falls back to user-<uuid8>).
-- Checking each row against already-written values makes collisions across bases (foo, an existing foo-2, a second foo) come out right;
-- the data cases in migrate.test.ts pin this. The uuid-shape test runs before the cut to 30, since a cut uuid prefix is no longer uuid-shaped.
-- No commit statement or concurrent-index syntax in this file: drizzle runs the whole migration in one transaction.
DO $$
DECLARE
  u RECORD;
  base text;
  cand text;
  n int;
BEGIN
  FOR u IN SELECT id, email FROM users ORDER BY created_at, id LOOP
    base := lower(split_part(u.email, '@', 1));
    base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '^-+|-+$', '', 'g');
    IF base = '' OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      base := 'user-' || substr(u.id::text, 1, 8);
    END IF;
    base := left(base, 30);
    base := regexp_replace(base, '-+$', '');

    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM handles WHERE handle = cand) AND n < 100 LOOP
      n := n + 1;
      cand := regexp_replace(left(base, 32 - length('-' || n::text)), '-+$', '') || '-' || n::text;
    END LOOP;
    IF EXISTS (SELECT 1 FROM handles WHERE handle = cand) THEN
      cand := 'user-' || substr(u.id::text, 1, 8);
    END IF;

    INSERT INTO handles (handle, user_id, state) VALUES (cand, u.id, 'live');
    UPDATE users SET handle = cand WHERE id = u.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET DEFAULT 'user-' || substr(gen_random_uuid()::text, 1, 8);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_unique" UNIQUE("handle");
