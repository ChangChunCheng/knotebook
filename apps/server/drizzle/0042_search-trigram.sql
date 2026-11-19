-- pg_trgm GIN index for body search: queries with a run of 3+ characters that pg_trgm indexes (depends on the database's LC_CTYPE) use `lower(body) LIKE` (see src/notes/search-sql.ts).
-- CREATE EXTENSION is hand-written; drizzle-kit does not generate it. pg_trgm is a trusted extension since PostgreSQL 13, so the database owner can create it without superuser.
-- The index is built inside the migration transaction and blocks writes to note_search_sections while it builds (roughly 1 minute per million sections).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "nss_body_trgm_idx" ON "note_search_sections" USING gin (lower("body") gin_trgm_ops);
