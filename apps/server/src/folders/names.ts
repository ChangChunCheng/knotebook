/** Folder names. Length counts code points (same unit as the DB `length()`), like `validateGroupName`. */
import { FOLDER_NAME_MAX } from "@knotebook/shared";
import { hasUnstorableChar } from "../oauth/storable.js";

/**
 * Shared by both normalizers: C0, DEL and C1, line/paragraph separators, bidi controls.
 * ZWNJ/ZWJ are kept because emoji sequences and some scripts need them.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const CONTROL_CHAR_RE_G = new RegExp(CONTROL_CHAR_RE.source, "gu");
const LONE_SURROGATE_RE_G = /\p{Surrogate}/gu;

export type FolderNameResult = { ok: true; name: string } | { ok: false; reason: "unstorable" | "control" | "length" };

/** Truncates to `max` code points, then trimEnd so a cut that lands on whitespace leaves no trailing space (and no double space before a suffix). */
function truncateCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("").trimEnd();
}

/** Strict, for user input: rejects unstorable characters, trims, then rejects (rather than strips) control characters; NFC; 1-80 code points. */
export function normalizeFolderName(raw: string): FolderNameResult {
  if (hasUnstorableChar(raw)) return { ok: false, reason: "unstorable" };
  const trimmed = raw.trim();
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false, reason: "control" };
  const name = trimmed.normalize("NFC");
  const length = Array.from(name).length;
  if (length < 1 || length > FOLDER_NAME_MAX) return { ok: false, reason: "length" };
  return { ok: true, name };
}

/** Lenient, for system-created folders: strips lone surrogates and control characters, uses `fallback` when empty, truncates to 80. Never fails. */
export function normalizeFolderNameLoose(raw: string, fallback: string): string {
  const cleaned = raw.replace(LONE_SURROGATE_RE_G, "").replace(CONTROL_CHAR_RE_G, "").normalize("NFC").trim();
  return truncateCodePoints(cleaned === "" ? fallback : cleaned, FOLDER_NAME_MAX);
}

/** n = 1 → `base`; n ≥ 2 → `base (n)` with base truncated so the result fits 80 code points and no double space precedes the suffix. */
export function folderNameWithSuffix(base: string, n: number): string {
  if (n <= 1) return truncateCodePoints(base, FOLDER_NAME_MAX);
  const suffix = ` (${n})`;
  return `${truncateCodePoints(base, FOLDER_NAME_MAX - Array.from(suffix).length)}${suffix}`;
}

/** Fixed name for the folder created on group deletion: "群組" if the first Accept-Language tag starts with zh, otherwise "Group". */
export function fallbackGroupFolderName(acceptLanguage: string | undefined): string {
  const first = (acceptLanguage ?? "").split(",")[0]!.trim().toLowerCase();
  return first.startsWith("zh") ? "群組" : "Group";
}
