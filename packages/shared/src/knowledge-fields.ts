export const KNOWLEDGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_MAX = 64;

export const KNOWLEDGE_BUILTIN_FIELDS = ["when", "conclusion", "evidence", "verified", "superseded_by"] as const;
export type KnowledgeBuiltinFieldKey = (typeof KNOWLEDGE_BUILTIN_FIELDS)[number];
export type KnowledgeFieldKey = KnowledgeBuiltinFieldKey | `x-${string}`;
export const KNOWLEDGE_CUSTOM_FIELD_TYPES = ["text", "select", "date", "link", "member"] as const;
export type KnowledgeCustomFieldType = (typeof KNOWLEDGE_CUSTOM_FIELD_TYPES)[number];
export type KnowledgeFieldType = KnowledgeCustomFieldType | "ref";
export const KNOWLEDGE_RESERVED_EVIDENCE_KEYS = ["tested", "docs", "inferred", "unconfirmed"] as const;
export const KNOWLEDGE_CUSTOM_ENABLED_MAX = 20;
export const KNOWLEDGE_CUSTOM_TOTAL_MAX = 100;
export const KNOWLEDGE_OPTIONS_MAX = 30;
/** Code points. */
export const KNOWLEDGE_FIELD_NAME_MAX = 60;

export interface KnowledgeOptionDef { key: string; name: string | null; enabled: boolean; builtin: boolean }
export interface KnowledgeFieldDef {
  key: KnowledgeFieldKey;
  builtin: boolean;
  type: KnowledgeFieldType;
  name: string | null;
  enabled: boolean;
  /** Present on single choice fields only. */
  options?: KnowledgeOptionDef[];
}
export interface KnowledgeFieldView { fields: KnowledgeFieldDef[] }
export interface KnowledgeFieldDefRow { kind: "field" | "option"; fieldRef: KnowledgeFieldKey; key: string; type: KnowledgeCustomFieldType | null; createdAt: string }
/** `optionKey` "" = the field itself; a null attribute inherits from the level above. */
export interface KnowledgeFieldOverrideRow { fieldRef: KnowledgeFieldKey; optionKey: string; enabled: boolean | null; name: string | null; position: number | null }

const BUILTIN_TYPES: Record<KnowledgeBuiltinFieldKey, KnowledgeFieldType> = {
  when: "text",
  conclusion: "text",
  evidence: "select",
  verified: "date",
  superseded_by: "ref",
};
// Must equal KNOWLEDGE_BUILTIN_EVIDENCE in knowledge.ts, which imports this module and so cannot be imported from here.
const BUILTIN_EVIDENCE_OPTIONS = ["tested", "docs", "inferred"] as const;

type Overrides = ReadonlyMap<string, KnowledgeFieldOverrideRow>;
const overrideKey = (fieldRef: string, optionKey: string): string => `${fieldRef}\u0000${optionKey}`;
function indexOverrides(rows: readonly KnowledgeFieldOverrideRow[] | undefined): Overrides {
  const m = new Map<string, KnowledgeFieldOverrideRow>();
  for (const r of rows ?? []) m.set(overrideKey(r.fieldRef, r.optionKey), r);
  return m;
}

interface Sortable { position: number | null; createdAt: string; key: string }
function bySortOrder(a: Sortable, b: Sortable): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function resolveKnowledgeFieldView(input: {
  defs: readonly KnowledgeFieldDefRow[];
  site: readonly KnowledgeFieldOverrideRow[];
  group?: readonly KnowledgeFieldOverrideRow[];
}): KnowledgeFieldView {
  const site = indexOverrides(input.site);
  const group = indexOverrides(input.group);
  const pick = <K extends "enabled" | "name" | "position">(fieldRef: string, optionKey: string, attr: K): KnowledgeFieldOverrideRow[K] | null => {
    const key = overrideKey(fieldRef, optionKey);
    return group.get(key)?.[attr] ?? site.get(key)?.[attr] ?? null;
  };

  const optionsOf = (fieldRef: string, builtinKeys: readonly string[]): KnowledgeOptionDef[] => {
    const rows: Array<Sortable & { def: KnowledgeOptionDef }> = [];
    const add = (key: string, builtin: boolean, createdAt: string, defaultPosition: number | null): void => {
      rows.push({
        key,
        createdAt,
        position: pick(fieldRef, key, "position") ?? defaultPosition,
        def: { key, name: pick(fieldRef, key, "name"), enabled: pick(fieldRef, key, "enabled") ?? true, builtin },
      });
    };
    builtinKeys.forEach((key, i) => add(key, true, "", i));
    for (const d of input.defs) if (d.kind === "option" && d.fieldRef === fieldRef) add(d.key, false, d.createdAt, null);
    return rows.sort(bySortOrder).map((r) => r.def);
  };

  const fields: KnowledgeFieldDef[] = KNOWLEDGE_BUILTIN_FIELDS.map((key) => {
    const field: KnowledgeFieldDef = { key, builtin: true, type: BUILTIN_TYPES[key], name: null, enabled: pick(key, "", "enabled") ?? true };
    if (key === "evidence") field.options = optionsOf(key, BUILTIN_EVIDENCE_OPTIONS);
    return field;
  });

  const custom: Array<Sortable & { def: KnowledgeFieldDef }> = [];
  for (const d of input.defs) {
    if (d.kind !== "field" || d.type === null) continue;
    const ref = d.fieldRef;
    const def: KnowledgeFieldDef = { key: ref, builtin: false, type: d.type, name: pick(ref, "", "name"), enabled: pick(ref, "", "enabled") ?? true };
    if (d.type === "select") def.options = optionsOf(ref, []);
    custom.push({ key: ref, createdAt: d.createdAt, position: pick(ref, "", "position"), def });
  }
  fields.push(...custom.sort(bySortOrder).map((c) => c.def));
  return { fields };
}

function freezeView(view: KnowledgeFieldView): KnowledgeFieldView {
  for (const field of view.fields) {
    for (const option of field.options ?? []) Object.freeze(option);
    if (field.options) Object.freeze(field.options);
    Object.freeze(field);
  }
  Object.freeze(view.fields);
  return Object.freeze(view);
}

// Frozen: every caller shares this one object.
export const DEFAULT_KNOWLEDGE_FIELD_VIEW: KnowledgeFieldView = /* @__PURE__ */ freezeView(/* @__PURE__ */ resolveKnowledgeFieldView({ defs: [], site: [] }));

export function knowledgeField(view: KnowledgeFieldView, key: KnowledgeFieldKey): KnowledgeFieldDef | undefined {
  return view.fields.find((f) => f.key === key);
}

export function isKnowledgeFieldEnabled(view: KnowledgeFieldView, key: KnowledgeFieldKey): boolean {
  return knowledgeField(view, key)?.enabled ?? false;
}

export function knowledgeOption(view: KnowledgeFieldView, field: KnowledgeFieldKey, key: string): KnowledgeOptionDef | undefined {
  return knowledgeField(view, field)?.options?.find((o) => o.key === key);
}

function randomBase36(length: number): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  const n = c && typeof c.getRandomValues === "function" ? c.getRandomValues(new Uint32Array(1))[0]! : Math.floor(Math.random() * 0x100000000);
  return (n % 36 ** length).toString(36).padStart(length, "0");
}

/** Callers put the reserved basis keys into `taken` when making an option key for the basis field. */
export function knowledgeKeyFromName(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX);
  if (base === "") {
    for (;;) {
      const key = `k${randomBase36(5)}`;
      if (!taken.has(key)) return key;
    }
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const key = `${base.slice(0, KEY_MAX - suffix.length)}${suffix}`;
    if (!taken.has(key)) return key;
  }
}
