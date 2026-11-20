-- site_limits holds the values saved from the admin page; no row means default/auto.
-- Rollback: old code ignores both tables and limits fall back to env/constants; the tables are harmless left in place, and their values take effect again after re-upgrading.
CREATE TABLE "site_limit_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" integer,
	"new_value" integer,
	"old_effective" integer NOT NULL,
	"new_effective" integer NOT NULL,
	"actor_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_limits_key_chk" CHECK ("site_limits"."key" ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
	CONSTRAINT "site_limits_value_chk" CHECK ("site_limits"."value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "site_limit_changes" ADD CONSTRAINT "site_limit_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_limit_changes_changed_at_idx" ON "site_limit_changes" USING btree ("changed_at" DESC NULLS LAST);