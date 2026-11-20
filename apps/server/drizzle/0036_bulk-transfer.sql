-- Rollback to 0.14: old code rejects bulk rows because the purpose doesn't match (403, the purpose comparison in transfer-auth.ts) and never reads the new columns or tables; note_ai_edits rows with op file_sync cannot be undone after a rollback.
CREATE TABLE "transfer_bases" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"salt" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"body_sha" "bytea" NOT NULL,
	"title_sha" "bytea" NOT NULL,
	"line_hashes" "bytea" NOT NULL,
	"line_kinds" "bytea" NOT NULL,
	"segments" jsonb,
	"applied_body_sha" "bytea",
	"applied_title_sha" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_creates" (
	"user_id" uuid NOT NULL,
	"file_sha" "bytea" NOT NULL,
	"note_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_creates_user_id_file_sha_pk" PRIMARY KEY("user_id","file_sha")
);
--> statement-breakpoint
ALTER TABLE "note_ai_edits" DROP CONSTRAINT "note_ai_edits_op_chk";--> statement-breakpoint
ALTER TABLE "note_ai_edits" DROP CONSTRAINT "note_ai_edits_anchor_chk";--> statement-breakpoint
ALTER TABLE "transfer_tokens" DROP CONSTRAINT "transfer_tokens_purpose_chk";--> statement-breakpoint
ALTER TABLE "transfer_tokens" ALTER COLUMN "note_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD COLUMN "access" text;--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD COLUMN "range" jsonb;--> statement-breakpoint
ALTER TABLE "transfer_bases" ADD CONSTRAINT "transfer_bases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_bases" ADD CONSTRAINT "transfer_bases_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_creates" ADD CONSTRAINT "transfer_creates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_creates" ADD CONSTRAINT "transfer_creates_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_bases_user_note_created_idx" ON "transfer_bases" USING btree ("user_id","note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfer_bases_last_used_idx" ON "transfer_bases" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "transfer_bases_note_idx" ON "transfer_bases" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "transfer_creates_created_idx" ON "transfer_creates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transfer_creates_note_idx" ON "transfer_creates" USING btree ("note_id");--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_op_chk" CHECK ("note_ai_edits"."op" in ('replace_all','replace_section','insert_after','append','delete_section','revert','file_sync'));--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_anchor_chk" CHECK (case when "note_ai_edits"."op" = 'delete_section' then "note_ai_edits"."anchor" is not null when "note_ai_edits"."op" = 'file_sync' then ("note_ai_edits"."anchor" is not null) = (cardinality("note_ai_edits"."after_block_ids") = 0) else "note_ai_edits"."anchor" is null end);--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_bulk_note_chk" CHECK (("transfer_tokens"."purpose" = 'bulk') = ("transfer_tokens"."note_id" is null));--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_bulk_access_chk" CHECK (("transfer_tokens"."purpose" = 'bulk') = ("transfer_tokens"."access" is not null));--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_bulk_range_chk" CHECK (("transfer_tokens"."purpose" = 'bulk') = ("transfer_tokens"."range" is not null));--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_access_chk" CHECK ("transfer_tokens"."access" in ('read','write'));--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_purpose_chk" CHECK ("transfer_tokens"."purpose" in ('upload','download','bulk'));