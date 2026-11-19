/** Only "not issued by this site" is rejected here; callers validate each segment's format (UUID_RE, Date, kind). */
import { noNul } from "../notes/schemas.js";

const SEP = "|";
export type KeysetCursorTag = "t" | "f" | "s";
export const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Parts must not contain "|" (callers pass only ISO times, UUIDs and kinds). */
export function encodeKeysetCursor(tag: KeysetCursorTag, parts: readonly string[]): string {
  return Buffer.from([tag, ...parts].join(SEP), "utf8").toString("base64url");
}

/** `Buffer.from(…, "base64url")` silently skips characters outside the charset, so check the charset first. */
export function decodeKeysetCursor(raw: string, tag: KeysetCursorTag, n: number): string[] | null {
  if (!BASE64URL_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!noNul(decoded)) return null;
  const parts = decoded.split(SEP);
  if (parts.length !== n + 1 || parts[0] !== tag) return null;
  return parts.slice(1);
}

const CURSOR_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Round-trip check plus a 4-digit year ≥ 1 reject forms JS accepts but pg `::timestamptz`
 * doesn't (`+275760-…`, `0000-…`); otherwise pg would error and the model would see `internal`.
 */
export function parseCursorTimestamp(ts: string): Date | null {
  if (!CURSOR_ISO_RE.test(ts)) return null;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== ts || at.getUTCFullYear() < 1) return null;
  return at;
}

export const BAD_CURSOR_MESSAGE = "The `cursor` value is not one this server issued. Omit it to start over.";
