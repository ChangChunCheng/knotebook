import { knowledgeStateOf, type KnowledgeInfo } from "./knowledge.js";
import { knowledgeMemberToken } from "./knowledge-custom.js";
import { KNOWLEDGE_KEY_RE, isKnowledgeFieldEnabled, type KnowledgeBuiltinFieldKey, type KnowledgeFieldView } from "./knowledge-fields.js";

export const KNOWLEDGE_COMMENT_MARK = "knotebook:knowledge";

export type KnowledgeCommentKey = "id" | "when" | "conclusion" | "evidence" | "verified" | "status" | "superseded_by";
export const KNOWLEDGE_COMMENT_KEYS: readonly KnowledgeCommentKey[] = ["id", "when", "conclusion", "evidence", "verified", "status", "superseded_by"];

export type KnowledgeCommentProblem = "not_multiline" | "bad_line" | "duplicate_key" | "bad_value" | "unstorable" | "blank_line_missing" | "two_comments" | "unclosed" | "bad_id";

export const KNOWLEDGE_IGNORE_REASONS = [
  "unknown_field",
  "field_disabled",
  "not_an_option",
  "bad_status",
  "bad_date",
  "bad_link",
  "unresolved_member",
  "bad_ref",
  "superseded_self",
  "too_long",
  "line_break",
] as const;
export type KnowledgeIgnoreReason = (typeof KNOWLEDGE_IGNORE_REASONS)[number];
/** `value`: for an unknown key, the raw text after the colon; for a known field, the decoded value before that field's rules (such as `unconfirmed` → ""). */
export interface KnowledgeIgnoredItem {
  heading: string;
  key: string;
  value: string;
  reason: KnowledgeIgnoreReason;
}

/**
 * Raw strings as written (after decoding); `evidence: unconfirmed` is already mapped to "". Values are not checked here.
 * `id` null = the line was left out. `custom`: each well-formed `x-<key>` line by its key without the prefix.
 * `unknown`: every other key in order, its text after the colon undecoded.
 */
export interface KnowledgeCommentFields {
  id: string | null;
  when: string;
  conclusion: string;
  evidence: string;
  verified: string;
  status: string;
  supersededBy: string;
  custom: Record<string, string>;
  unknown: Array<{ key: string; raw: string }>;
}

export interface KnowledgeProblem {
  problem: KnowledgeCommentProblem;
  key?: KnowledgeCommentKey | `x-${string}`;
  /** Plain text of the heading, not cut. */
  heading: string;
}

// `--` is quoted as a whole so neither `-->` nor `--!>` (which HTML also treats as a comment end) can appear.
// Lone surrogates are quoted because JSON.stringify escapes them, which keeps the text well-formed.
const NEEDS_QUOTES = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]|--|\p{Surrogate}/u;
// JSON.stringify leaves these raw; `>` is escaped so `--!>` cannot end the comment early.
const EXTRA_ESCAPES = /[>\u{7f}-\u{9f}\u{2028}\u{2029}]/gu;
const unicodeEscape = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

export function encodeKnowledgeValue(value: string): string {
  if (value === value.trim() && !value.startsWith('"') && !NEEDS_QUOTES.test(value)) return value;
  return JSON.stringify(value).replace(EXTRA_ESCAPES, unicodeEscape);
}

/** `raw` is the text after the colon, already trimmed. null: it starts with `"` but isn't exactly one JSON string. */
export function decodeKnowledgeValue(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const BUILTIN_VALUES: ReadonlyArray<readonly [KnowledgeBuiltinFieldKey, (info: KnowledgeInfo) => string]> = [
  ["when", i => i.when],
  ["conclusion", i => i.conclusion],
  ["evidence", i => i.evidence],
  ["verified", i => i.verified],
  ["superseded_by", i => i.supersededBy],
];

/**
 * A turned-off field is left out; a stored basis or choice is written even when its option is hidden, so writing the comment
 * back keeps it. A member without an entry in `handleOf` is written as `user:<id>`.
 */
export function formatKnowledgeComment(info: KnowledgeInfo, fields: KnowledgeFieldView, handleOf: ReadonlyMap<string, string> = new Map()): string {
  const lines = [`<!-- ${KNOWLEDGE_COMMENT_MARK}`, `id: ${encodeKnowledgeValue(info.id)}`];
  for (const [key, valueOf] of BUILTIN_VALUES) {
    const value = valueOf(info);
    if (value !== "" && isKnowledgeFieldEnabled(fields, key)) lines.push(`${key}: ${encodeKnowledgeValue(value)}`);
  }
  lines.push(`status: ${knowledgeStateOf(info)}`);
  for (const field of fields.fields) {
    if (field.builtin || !field.enabled) continue;
    const key = field.key.slice("x-".length);
    const value = Object.hasOwn(info.custom, key) ? info.custom[key]! : "";
    if (value === "") continue;
    lines.push(`${field.key}: ${encodeKnowledgeValue(field.type === "member" ? knowledgeMemberToken(value, handleOf) : value)}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

const MARK_START = /^\s*knotebook:knowledge(\s|$)/;
/** `data` is a Comment node's data: the text between `<!--` and `-->`. */
export function isKnowledgeCommentData(data: string): boolean {
  return MARK_START.test(data);
}

const FIELD_OF: Record<KnowledgeCommentKey, Exclude<keyof KnowledgeCommentFields, "unknown" | "custom">> = {
  id: "id",
  when: "when",
  conclusion: "conclusion",
  evidence: "evidence",
  verified: "verified",
  status: "status",
  superseded_by: "supersededBy",
};
const isKnownKey = (key: string): key is KnowledgeCommentKey => Object.hasOwn(FIELD_OF, key);
const isCustomKey = (key: string): key is `x-${string}` => key.startsWith("x-") && KNOWLEDGE_KEY_RE.test(key.slice(2));
const UNKNOWN_KEY_MAX = 80;
const cutKey = (key: string): string => {
  const points = Array.from(key);
  return points.length > UNKNOWN_KEY_MAX ? points.slice(0, UNKNOWN_KEY_MAX).join("") : key;
};

export function parseKnowledgeComment(
  data: string,
): { ok: true; fields: KnowledgeCommentFields } | { ok: false; problem: KnowledgeCommentProblem; key?: KnowledgeProblem["key"] } {
  const lines = data.split(/\r\n|\r|\n/);
  if (lines.length < 2 || lines[0]!.trim() !== KNOWLEDGE_COMMENT_MARK) return { ok: false, problem: "not_multiline" };
  let end = lines.length;
  while (end > 1 && lines[end - 1]!.trim() === "") end -= 1;
  const fields: KnowledgeCommentFields = { id: null, when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", custom: {}, unknown: [] };
  const seen = new Set<string>();
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!.trimStart();
    const colon = line.indexOf(":");
    if (colon === -1) return { ok: false, problem: "bad_line" };
    const key = line.slice(0, colon).trimEnd();
    if (key === "") return { ok: false, problem: "bad_line" };
    const raw = line.slice(colon + 1).trim();
    // A key this version doesn't know must not refuse the whole comment; it is reported later as ignored.
    if (!isKnownKey(key) && !isCustomKey(key)) {
      fields.unknown.push({ key: cutKey(key), raw });
      continue;
    }
    if (seen.has(key)) return { ok: false, problem: "duplicate_key", key };
    seen.add(key);
    const value = decodeKnowledgeValue(raw);
    if (value === null) return { ok: false, problem: "bad_value", key };
    if (value.includes("\u0000") || /\p{Surrogate}/u.test(value)) return { ok: false, problem: "unstorable", key };
    if (!isKnownKey(key)) fields.custom[key.slice("x-".length)] = value;
    else if (key === "id") fields.id = value === "" ? null : value;
    else if (key === "evidence") fields.evidence = value === "unconfirmed" ? "" : value;
    else fields[FIELD_OF[key] as Exclude<keyof KnowledgeCommentFields, "id" | "unknown" | "custom">] = value;
  }
  return { ok: true, fields };
}
