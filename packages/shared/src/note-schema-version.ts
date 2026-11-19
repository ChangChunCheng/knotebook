// Compared with `!==`, not `<`: a server rollback also needs a reload. A collab token without it counts as 0.
// Bump on any schema change; the digest test in note-schema-version.test.ts enforces it.
export const NOTE_SCHEMA_VERSION = 2;
