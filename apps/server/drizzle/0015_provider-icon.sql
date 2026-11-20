ALTER TABLE "auth_providers" ADD COLUMN "icon_kind" text DEFAULT 'template' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "icon_data" "bytea";--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "icon_mime" text;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "icon_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_icon_kind_chk" CHECK ("auth_providers"."icon_kind" in ('template', 'gitlab', 'google', 'upload', 'none'));--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_icon_upload_chk" CHECK (("auth_providers"."icon_kind" = 'upload' and "auth_providers"."icon_data" is not null and "auth_providers"."icon_mime" is not null) or ("auth_providers"."icon_kind" <> 'upload' and "auth_providers"."icon_data" is null and "auth_providers"."icon_mime" is null));--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_icon_mime_chk" CHECK ("auth_providers"."icon_mime" is null or "auth_providers"."icon_mime" in ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_icon_size_chk" CHECK ("auth_providers"."icon_data" is null or octet_length("auth_providers"."icon_data") <= 262144);