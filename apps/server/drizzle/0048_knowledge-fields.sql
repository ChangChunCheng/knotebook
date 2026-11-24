-- Only adds two tables (knowledge field definitions and their per-level overrides); no existing table or row is touched.
-- Rollback: version 0.18 never reads these tables, so leaving them in place is harmless.
CREATE TABLE "knowledge_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"field_ref" text NOT NULL,
	"key" text NOT NULL,
	"type" text,
	"origin_kind" text NOT NULL,
	"origin_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kfd_key_chk" CHECK ("knowledge_field_defs"."key" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "kfd_field_ref_chk" CHECK ("knowledge_field_defs"."field_ref" = 'evidence' or "knowledge_field_defs"."field_ref" ~ '^x-[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "kfd_kind_type_chk" CHECK (("knowledge_field_defs"."kind" = 'field' and "knowledge_field_defs"."type" is not null and "knowledge_field_defs"."type" in ('text', 'select', 'date', 'link', 'member') and "knowledge_field_defs"."field_ref" = 'x-' || "knowledge_field_defs"."key") or ("knowledge_field_defs"."kind" = 'option' and "knowledge_field_defs"."type" is null)),
	CONSTRAINT "kfd_reserved_chk" CHECK (not ("knowledge_field_defs"."kind" = 'option' and "knowledge_field_defs"."field_ref" = 'evidence' and "knowledge_field_defs"."key" in ('tested', 'docs', 'inferred', 'unconfirmed'))),
	CONSTRAINT "kfd_origin_chk" CHECK (("knowledge_field_defs"."origin_kind" = 'site' and "knowledge_field_defs"."origin_group_id" is null) or "knowledge_field_defs"."origin_kind" = 'group')
);
--> statement-breakpoint
CREATE TABLE "knowledge_field_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"field_ref" text NOT NULL,
	"option_key" text DEFAULT '' NOT NULL,
	"enabled" boolean,
	"name" text,
	"position" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kfo_field_ref_chk" CHECK ("knowledge_field_overrides"."field_ref" in ('when', 'conclusion', 'evidence', 'verified', 'superseded_by') or "knowledge_field_overrides"."field_ref" ~ '^x-[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "kfo_option_key_chk" CHECK ("knowledge_field_overrides"."option_key" = '' or "knowledge_field_overrides"."option_key" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "kfo_name_chk" CHECK ("knowledge_field_overrides"."name" is null or char_length("knowledge_field_overrides"."name") between 1 and 60),
	CONSTRAINT "kfo_position_chk" CHECK ("knowledge_field_overrides"."position" is null or "knowledge_field_overrides"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge_field_defs" ADD CONSTRAINT "knowledge_field_defs_origin_group_id_groups_id_fk" FOREIGN KEY ("origin_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_field_overrides" ADD CONSTRAINT "knowledge_field_overrides_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kfd_field_idx" ON "knowledge_field_defs" USING btree ("field_ref") WHERE "knowledge_field_defs"."kind" = 'field';--> statement-breakpoint
CREATE UNIQUE INDEX "kfd_option_idx" ON "knowledge_field_defs" USING btree ("field_ref","key") WHERE "knowledge_field_defs"."kind" = 'option';--> statement-breakpoint
CREATE UNIQUE INDEX "kfo_site_idx" ON "knowledge_field_overrides" USING btree ("field_ref","option_key") WHERE "knowledge_field_overrides"."group_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "kfo_group_idx" ON "knowledge_field_overrides" USING btree ("group_id","field_ref","option_key") WHERE "knowledge_field_overrides"."group_id" is not null;