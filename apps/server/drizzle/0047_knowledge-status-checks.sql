-- Only widens nk_evidence_chk (any option key) and nk_status_chk (adds 'verified'); every existing row already satisfies both, so no row is changed.
-- Rollback: version 0.18 never writes the new values, so leaving the wider checks in place is harmless.
ALTER TABLE "note_knowledge" DROP CONSTRAINT "nk_evidence_chk";--> statement-breakpoint
ALTER TABLE "note_knowledge" DROP CONSTRAINT "nk_status_chk";--> statement-breakpoint
ALTER TABLE "note_knowledge" ADD CONSTRAINT "nk_evidence_chk" CHECK ("note_knowledge"."evidence" = '' or "note_knowledge"."evidence" ~ '^[a-z0-9][a-z0-9-]{0,63}$');--> statement-breakpoint
ALTER TABLE "note_knowledge" ADD CONSTRAINT "nk_status_chk" CHECK ("note_knowledge"."status" in ('', 'verified', 'unverified', 'outdated'));