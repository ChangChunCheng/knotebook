-- #240: ids differing only in case slipped past the case-sensitive self-link filter in JS and normalized to the same value in the uuid column, leaving source = target rows; delete them. Idempotent.
DELETE FROM "note_links" WHERE "source_note_id" = "target_note_id";
