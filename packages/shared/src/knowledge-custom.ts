import { KNOWLEDGE_KEY_RE, type KnowledgeFieldView } from "./knowledge-fields.js";
import type { KnowledgeInfo } from "./knowledge.js";
import type { KnowledgeBlockShape } from "./knowledge-rewrite.js";

/** Code points. */
export const KNOWLEDGE_CUSTOM_TEXT_MAX = 300;
export const KNOWLEDGE_CUSTOM_LINK_MAX = 2048;
/** UTF-16 units of the normalized JSON. */
export const KNOWLEDGE_CUSTOM_JSON_MAX = 65_536;

// Null prototype: "constructor" is a valid field key, and on a plain object it would read as Object's constructor when unset.
function emptyValues(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Collab state is untrusted: anything but an object of KNOWLEDGE_KEY_RE keys to string values is skipped entry by entry. */
export function parseKnowledgeCustom(raw: unknown): Readonly<Record<string, string>> {
  const out = emptyValues();
  if (typeof raw !== "string" || raw === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value !== "" && KNOWLEDGE_KEY_RE.test(key)) out[key] = value;
  }
  return out;
}

/** Keys sorted, empty values dropped, "" when nothing is left. */
export function formatKnowledgeCustom(values: Readonly<Record<string, string>>): string {
  const keys = Object.keys(values)
    .filter(k => typeof values[k] === "string" && values[k] !== "")
    .sort();
  if (keys.length === 0) return "";
  const sorted = emptyValues();
  for (const k of keys) sorted[k] = values[k]!;
  return JSON.stringify(sorted);
}

// Whitespace and controls are refused outright: browsers strip some of them from a URL before parsing, so the href followed
// would differ from the one checked.
const UNSAFE_CHAR = /[\s\u0000-\u001f\u007f-\u009f]/u;

/** http(s) URL or a same-site path ("/…" but not "//…"); null for anything else. */
export function safeKnowledgeHref(value: string): string | null {
  if (value === "" || UNSAFE_CHAR.test(value)) return null;
  if (value.startsWith("/")) {
    // Browsers read "\" as "/" in http(s) URLs, so "/\host" is protocol-relative too.
    return value[1] === "/" || value.includes("\\") ? null : value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? value : null;
}

export interface KnowledgeMemberMaps {
  handleOf: ReadonlyMap<string, string>;
  idOf: ReadonlyMap<string, string>;
}

export function knowledgeMemberToken(userId: string, handleOf: ReadonlyMap<string, string>): string {
  return handleOf.get(userId) ?? `user:${userId}`;
}

function memberFieldKeys(fields: KnowledgeFieldView): string[] {
  return fields.fields.filter(f => !f.builtin && f.enabled && f.type === "member").map(f => f.key.slice("x-".length));
}

/** Member tokens written in custom values of member fields, lowercased, for resolving before sanitizeKnowledgeForWrite. */
export function knowledgeMemberTokensIn(blocks: readonly KnowledgeBlockShape[], fields: KnowledgeFieldView): string[] {
  const keys = memberFieldKeys(fields);
  const out = new Set<string>();
  if (keys.length === 0) return [];
  for (const b of blocks) {
    const id = b.props?.knowledgeId;
    if (b.type !== "heading" || typeof id !== "string" || id === "") continue;
    const values = parseKnowledgeCustom(b.props?.knowledgeCustom);
    for (const key of keys) if (Object.hasOwn(values, key)) out.add(values[key]!.toLowerCase());
  }
  return [...out];
}

/** Stored member ids in `current`, for building handleOf. */
export function knowledgeMemberIdsIn(infos: Iterable<KnowledgeInfo>, fields: KnowledgeFieldView): string[] {
  const keys = memberFieldKeys(fields);
  const out = new Set<string>();
  if (keys.length === 0) return [];
  for (const info of infos) for (const key of keys) if (Object.hasOwn(info.custom, key)) out.add(info.custom[key]!);
  return [...out];
}
