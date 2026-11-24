-- Only adds one nullable column; no existing row is changed.
-- Rollback: version 0.18 never reads note_knowledge.custom, so leaving the column in place is harmless.
ALTER TABLE "note_knowledge" ADD COLUMN "custom" jsonb;