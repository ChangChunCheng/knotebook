CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid,
	"group_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_kind_chk" CHECK ("folders"."kind" in ('personal','group','shared')),
	CONSTRAINT "folders_space_chk" CHECK (("folders"."kind" = 'group') = ("folders"."group_id" is not null) and ("folders"."owner_id" is null) = ("folders"."group_id" is not null)),
	CONSTRAINT "folders_name_chk" CHECK (length("folders"."name") between 1 and 80),
	CONSTRAINT "folders_parent_not_self_chk" CHECK ("folders"."parent_id" is distinct from "folders"."id")
);
--> statement-breakpoint
CREATE TABLE "note_placements" (
	"user_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	CONSTRAINT "note_placements_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "trash_folder_path" jsonb;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_placements" ADD CONSTRAINT "note_placements_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_placements" ADD CONSTRAINT "note_placements_share_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."note_shares"("note_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_owner_idx" ON "folders" USING btree ("owner_id") WHERE "folders"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "folders_group_idx" ON "folders" USING btree ("group_id") WHERE "folders"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("parent_id") WHERE "folders"."parent_id" is not null;--> statement-breakpoint
CREATE INDEX "note_placements_folder_idx" ON "note_placements" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_folder_idx" ON "notes" USING btree ("folder_id") WHERE "notes"."folder_id" is not null;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_trash_folder_path_chk" CHECK ("notes"."trash_folder_path" is null or jsonb_typeof("notes"."trash_folder_path") = 'array');--> statement-breakpoint
-- Hand-written (drizzle can't express it): sibling names are unique case-insensitively; NULLS NOT DISTINCT makes NULL parents (root level) compare equal.
CREATE UNIQUE INDEX "folders_sibling_name_idx" ON "folders" ("kind", "owner_id", "group_id", "parent_id", lower("name")) NULLS NOT DISTINCT;--> statement-breakpoint
-- A note and its folder must be in the same space. If ownership changed but folder_id did not (older code moving a note into a group, or a transfer), self-heal folder_id to NULL; otherwise raise KF001.
CREATE FUNCTION notes_folder_space_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE f record;
BEGIN
  IF NEW.folder_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind, owner_id, group_id INTO f FROM folders WHERE id = NEW.folder_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- left to notes_folder_fk to report 23503
  IF (f.kind = 'personal' AND f.owner_id = NEW.owner_id) OR (f.kind = 'group' AND f.group_id = NEW.group_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.folder_id IS NOT DISTINCT FROM OLD.folder_id THEN NEW.folder_id := NULL; RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'KF001', MESSAGE = 'notes.folder_id must point to a folder in the note''s own space';
END $fn$;--> statement-breakpoint
CREATE TRIGGER notes_folder_space_trg BEFORE INSERT OR UPDATE OF folder_id, owner_id, group_id ON notes FOR EACH ROW EXECUTE FUNCTION notes_folder_space_guard();--> statement-breakpoint
-- A parent and child must be in the same space. Plain AFTER ROW: checked at statement end, so a transfer can rewrite a whole tree in one UPDATE; not DEFERRABLE.
CREATE FUNCTION folders_parent_space_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE p record;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NULL; END IF;
  SELECT kind, owner_id, group_id INTO p FROM folders WHERE id = NEW.parent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p.kind IS DISTINCT FROM NEW.kind OR p.owner_id IS DISTINCT FROM NEW.owner_id OR p.group_id IS DISTINCT FROM NEW.group_id THEN
    RAISE EXCEPTION USING ERRCODE = 'KF002', MESSAGE = 'folders.parent_id must point to a folder in the same space';
  END IF;
  RETURN NULL;
END $fn$;--> statement-breakpoint
CREATE TRIGGER folders_parent_space_trg AFTER INSERT OR UPDATE OF parent_id, kind, owner_id, group_id ON folders FOR EACH ROW EXECUTE FUNCTION folders_parent_space_guard();--> statement-breakpoint
CREATE FUNCTION note_placements_folder_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'shared' AND owner_id = NEW.user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'KF003', MESSAGE = 'note_placements.folder_id must be the placer''s own shared folder';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER note_placements_folder_trg BEFORE INSERT OR UPDATE ON note_placements FOR EACH ROW EXECUTE FUNCTION note_placements_folder_guard();
