export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_SERIALIZATION_FAILURE = "40001";
export const PG_DEADLOCK_DETECTED = "40P01";

// Matches both node-postgres `DatabaseError` (`.code` on top) and drizzle-orm 0.44's `DrizzleQueryError` (pg error in `.cause`).
function code(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined;
}

function matchesCode(err: unknown, target: string): boolean {
  if (code(err) === target) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return code(cause) === target;
}

export function isUniqueViolation(err: unknown): boolean {
  return matchesCode(err, PG_UNIQUE_VIOLATION);
}

function constraintOf(e: unknown): string | null {
  const value =
    typeof e === "object" && e !== null && "constraint" in e ? (e as { constraint?: unknown }).constraint : undefined;
  return typeof value === "string" ? value : null;
}

/** Tables with several unique keys need the constraint name; callers rethrow names they don't know. */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  const direct = constraintOf(err);
  if (direct !== null) return direct;
  return constraintOf(err instanceof Error ? err.cause : undefined);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return matchesCode(err, PG_FOREIGN_KEY_VIOLATION);
}

// Separate from FK violations: those are recoverable (drop the target, retry once); 40001/40P01 are only answered for the client to retry, never retried server-side.
export function isTransientTransactionError(err: unknown): boolean {
  return matchesCode(err, PG_SERIALIZATION_FAILURE) || matchesCode(err, PG_DEADLOCK_DETECTED);
}

export const PG_CHECK_VIOLATION = "23514";

/** Callers rethrow names they don't know: input validation mirrors the CHECKs, so hitting another one is a bug. */
export function checkViolationConstraint(err: unknown): string | null {
  if (!matchesCode(err, PG_CHECK_VIOLATION)) return null;
  const direct = constraintOf(err);
  if (direct !== null) return direct;
  return constraintOf(err instanceof Error ? err.cause : undefined);
}

/** Deliberately omits message/detail/params: they carry the written values. */
export function pgErrorSummary(err: unknown): { code: string | null; constraint: string | null } {
  const cause = err instanceof Error ? err.cause : undefined;
  const raw = code(err) ?? code(cause);
  return {
    code: typeof raw === "string" ? raw : null,
    constraint: constraintOf(err) ?? constraintOf(cause),
  };
}

export const PG_LOCK_NOT_AVAILABLE = "55P03";
export const PG_NOT_NULL_VIOLATION = "23502";

export function isLockTimeout(err: unknown): boolean {
  return matchesCode(err, PG_LOCK_NOT_AVAILABLE);
}

/** Concurrency victims that wrote nothing; routes map them to 409 `server_busy`. */
export function isRetryableTxError(err: unknown): boolean {
  return isTransientTransactionError(err) || isLockTimeout(err);
}

export function foreignKeyViolationConstraint(err: unknown): string | null {
  if (!isForeignKeyViolation(err)) return null;
  return constraintOf(err) ?? constraintOf(err instanceof Error ? err.cause : undefined);
}

function columnOf(e: unknown): string | null {
  const value = typeof e === "object" && e !== null && "column" in e ? (e as { column?: unknown }).column : undefined;
  return typeof value === "string" ? value : null;
}

/** e.g. `storage_plan_id` when `site_settings` has no row and its DEFAULT function returns NULL. */
export function notNullViolationColumn(err: unknown): string | null {
  if (!matchesCode(err, PG_NOT_NULL_VIOLATION)) return null;
  return columnOf(err) ?? columnOf(err instanceof Error ? err.cause : undefined);
}

// Custom SQLSTATEs raised by the triggers in migration 0034.
export const PG_NOTE_FOLDER_SPACE = "KF001";   // notes_folder_space_trg: note and its folder in different spaces
export const PG_FOLDER_PARENT_SPACE = "KF002"; // folders_parent_space_trg: parent and child in different spaces
export const PG_PLACEMENT_FOLDER = "KF003";    // note_placements_folder_trg: not the placer's own shared folder

/** Raised when the folder changed space between authorization and the write (e.g. a group transfer); callers treat it as folder not found. */
export function isNoteFolderSpaceViolation(err: unknown): boolean {
  return matchesCode(err, PG_NOTE_FOLDER_SPACE);
}

export function isFolderSpaceViolation(err: unknown): boolean {
  return (
    matchesCode(err, PG_NOTE_FOLDER_SPACE) || matchesCode(err, PG_FOLDER_PARENT_SPACE) || matchesCode(err, PG_PLACEMENT_FOLDER)
  );
}
