-- The note_id index backs the cascade when a note is permanently deleted.
-- Rollback: old code doesn't read the table, which is harmless left in place; after re-upgrading, its rows take effect again.
CREATE TABLE "note_favorites" (
	"user_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "note_favorites_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "note_favorites" ADD CONSTRAINT "note_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favorites" ADD CONSTRAINT "note_favorites_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_favorites_note_idx" ON "note_favorites" USING btree ("note_id");