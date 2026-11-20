-- Hand-completed after the drizzle-kit output: the Basic plan row, the site_settings backfill, the default-plan function, and the order of
-- the users/groups backfill, SET NOT NULL and SET DEFAULT. The function must exist before SET DEFAULT references it, and each backfill
-- must precede its SET NOT NULL.
-- No concurrent-index syntax or line-leading commit keyword in this file: migrate.test.ts greps the whole file, comments included.
CREATE TABLE "storage_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"quota_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_plans_name_chk" CHECK (char_length("storage_plans"."name") between 1 and 40),
	CONSTRAINT "storage_plans_quota_chk" CHECK ("storage_plans"."quota_bytes" is null or "storage_plans"."quota_bytes" between 0 and 1125899906842624)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_plans_name_lower_idx" ON "storage_plans" USING btree (lower("name"));--> statement-breakpoint
INSERT INTO "storage_plans" ("name", "quota_bytes") VALUES ('Basic', 2147483648);--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "default_user_storage_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "default_group_storage_plan_id" uuid;--> statement-breakpoint
UPDATE "site_settings" SET "default_user_storage_plan_id" = (SELECT "id" FROM "storage_plans" WHERE "name" = 'Basic'), "default_group_storage_plan_id" = (SELECT "id" FROM "storage_plans" WHERE "name" = 'Basic');--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "default_user_storage_plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "default_group_storage_plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_default_user_plan_fk" FOREIGN KEY ("default_user_storage_plan_id") REFERENCES "public"."storage_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_default_group_plan_fk" FOREIGN KEY ("default_group_storage_plan_id") REFERENCES "public"."storage_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION public.knotebook_default_storage_plan(kind text) RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT CASE kind WHEN 'user' THEN default_user_storage_plan_id
                     WHEN 'group' THEN default_group_storage_plan_id END
      FROM public.site_settings WHERE singleton
  $$;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storage_plan_id" uuid;--> statement-breakpoint
UPDATE "users" SET "storage_plan_id" = (SELECT "id" FROM "storage_plans" WHERE "name" = 'Basic');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storage_plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storage_plan_id" SET DEFAULT public.knotebook_default_storage_plan('user');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_storage_plan_fk" FOREIGN KEY ("storage_plan_id") REFERENCES "public"."storage_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_storage_plan_idx" ON "users" USING btree ("storage_plan_id");--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "storage_plan_id" uuid;--> statement-breakpoint
UPDATE "groups" SET "storage_plan_id" = (SELECT "id" FROM "storage_plans" WHERE "name" = 'Basic');--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "storage_plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "storage_plan_id" SET DEFAULT public.knotebook_default_storage_plan('group');--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_storage_plan_fk" FOREIGN KEY ("storage_plan_id") REFERENCES "public"."storage_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "groups_storage_plan_idx" ON "groups" USING btree ("storage_plan_id");