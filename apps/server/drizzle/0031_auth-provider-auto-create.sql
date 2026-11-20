ALTER TABLE "auth_providers" ADD COLUMN "auto_create_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing providers inherit the pre-upgrade registration_enabled; false if site_settings has no row (0014 creates it, so the fallback is a safeguard).
UPDATE "auth_providers" SET "auto_create_enabled" = coalesce((SELECT "registration_enabled" FROM "site_settings" WHERE "singleton"), false);
