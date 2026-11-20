CREATE TABLE "auth_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"display_name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"resolved_issuer" text,
	"client_id" text NOT NULL,
	"client_secret_encrypted" jsonb,
	"enabled" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"legacy_callback" boolean DEFAULT false NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_providers_template_chk" CHECK ("auth_providers"."template" in ('gitlab', 'google', 'oidc')),
	CONSTRAINT "auth_providers_display_name_chk" CHECK (char_length("auth_providers"."display_name") between 1 and 40),
	CONSTRAINT "auth_providers_issuer_url_chk" CHECK ("auth_providers"."issuer_url" ~ '^https?://' and char_length("auth_providers"."issuer_url") <= 512),
	CONSTRAINT "auth_providers_resolved_issuer_chk" CHECK ("auth_providers"."resolved_issuer" is null or char_length("auth_providers"."resolved_issuer") <= 512),
	CONSTRAINT "auth_providers_client_id_chk" CHECK (char_length("auth_providers"."client_id") between 1 and 512),
	CONSTRAINT "auth_providers_enabled_secret_chk" CHECK (not "auth_providers"."enabled" or "auth_providers"."client_secret_encrypted" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_providers_legacy_callback_idx" ON "auth_providers" USING btree ("legacy_callback") WHERE "auth_providers"."legacy_callback";
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_issuer_sub_idx" ON "user_identities" USING btree ("issuer","sub");
--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");
--> statement-breakpoint
-- Existing bindings (including past verified-email auto-merges) stay valid; rows with only one of issuer/sub are not copied; users_oidc_idx (unique on oidc_issuer, oidc_sub) guarantees the copy can't violate user_identities_issuer_sub_idx.
INSERT INTO "user_identities" ("user_id", "issuer", "sub", "created_at")
  SELECT "id", "oidc_issuer", "oidc_sub", "created_at" FROM "users" WHERE "oidc_issuer" IS NOT NULL AND "oidc_sub" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"registration_enabled" boolean DEFAULT true NOT NULL,
	"password_login_enabled" boolean DEFAULT true NOT NULL,
	"legacy_oidc_env_handled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_settings_singleton_chk" CHECK ("site_settings"."singleton")
);
--> statement-breakpoint
-- registration_enabled and password_login_enabled both take DEFAULT true, regardless of instance_setup.
INSERT INTO "site_settings" ("singleton") VALUES (true);
