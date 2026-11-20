-- applied_edit_ids: ids of the note_ai_edits rows recorded when this file was written back. Resending the same file when any of them has been reverted gives 409 base_unavailable (reason reverted) instead of unchanged.
-- Nullable, no backfill: an old row is NULL = no record to check, treated as not reverted. Rollback: old code doesn't read this column.
ALTER TABLE "transfer_bases" ADD COLUMN "applied_edit_ids" uuid[];
