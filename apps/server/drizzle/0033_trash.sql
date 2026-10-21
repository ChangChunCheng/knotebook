-- #181 垃圾桶：notes 加 deleted_by（FK set null）＋CHECK（有刪除者必有刪除時刻）＋deleted_at partial index；site_settings 加 trash_retention_days（NULL＝不自動刪，預設 7）＋CHECK 1–3650；只加欄／索引／CHECK，單一交易、無非交易式 DDL；既有 deleted_at 不回填。
ALTER TABLE "notes" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "trash_retention_days" integer DEFAULT 7;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deleted_by_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_deleted_at_idx" ON "notes" USING btree ("deleted_at") WHERE "notes"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deleted_by_chk" CHECK ("notes"."deleted_by" is null or "notes"."deleted_at" is not null);--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_trash_retention_chk" CHECK ("site_settings"."trash_retention_days" is null or ("site_settings"."trash_retention_days" >= 1 and "site_settings"."trash_retention_days" <= 3650));