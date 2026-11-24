import {
  KNOWLEDGE_CUSTOM_ENABLED_MAX,
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  knowledgeKeyFromName,
  type AdminKnowledgeFieldsDto,
  type KnowledgeCustomFieldType,
  type KnowledgeFieldInput,
  type KnowledgeFieldKey,
  type KnowledgeFieldType,
  type SiteKnowledgeFieldsInput,
} from "@knotebook/shared";

export interface KnowledgeFieldsDraftOption { key: string; name: string; enabled: boolean; isNew: boolean; /** Set once the admin types in the key box; until then the key follows the name. */ keyEdited?: boolean; /** React identity of a new row, whose key changes while it is typed. */ uid?: number }
export interface KnowledgeFieldsDraftField {
  key: KnowledgeFieldKey;
  enabled: boolean;
  name: string;
  type: KnowledgeFieldType;
  builtin: boolean;
  options: KnowledgeFieldsDraftOption[];
  /** A custom field added in this session; its key is still editable and its type is sent once. */
  isNew?: boolean;
  /** React identity of a new row, whose key changes while it is typed. */
  uid?: number;
}
/** Addresses a field by key, or by position when a new row's key is not unique yet. */
export type FieldRef = KnowledgeFieldKey | number;
export interface KnowledgeFieldsDraft { fields: KnowledgeFieldsDraftField[] }

export function draftFromAdmin(dto: AdminKnowledgeFieldsDto): KnowledgeFieldsDraft {
  return {
    fields: dto.fields.map((f) => ({
      key: f.key,
      enabled: f.enabled,
      name: f.name ?? "",
      type: f.type,
      builtin: f.builtin,
      options: (f.options ?? []).map((o) => ({ key: o.key, name: o.name ?? "", enabled: o.enabled, isNew: false })),
    })),
  };
}

/** Builtin fields are sent without `name`; an option's blank name is sent as null. Only fields with options carry `options`. */
export function inputFromDraft(draft: KnowledgeFieldsDraft): SiteKnowledgeFieldsInput {
  return {
    fields: draft.fields.map((f): KnowledgeFieldInput => {
      const out: KnowledgeFieldInput = { key: f.key, enabled: f.enabled };
      if (!f.builtin) {
        out.name = f.name.trim() === "" ? null : f.name.trim();
        if (f.isNew) out.type = f.type as KnowledgeCustomFieldType;
      }
      if (f.type === "select") out.options = f.options.map((o) => ({ key: o.key, name: o.name.trim() === "" ? null : o.name.trim(), enabled: o.enabled }));
      return out;
    }),
  };
}

function mapField(draft: KnowledgeFieldsDraft, field: FieldRef, fn: (f: KnowledgeFieldsDraftField) => KnowledgeFieldsDraftField): KnowledgeFieldsDraft {
  return { fields: draft.fields.map((f, i) => ((typeof field === "number" ? i === field : f.key === field) ? fn(f) : f)) };
}

export function setFieldEnabled(draft: KnowledgeFieldsDraft, field: FieldRef, enabled: boolean): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, enabled }));
}

export function moveOption(draft: KnowledgeFieldsDraft, field: FieldRef, from: number, by: -1 | 1): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => {
    const to = from + by;
    if (from < 0 || to < 0 || to >= f.options.length) return f;
    const options = [...f.options];
    [options[from], options[to]] = [options[to]!, options[from]!];
    return { ...f, options };
  });
}

function takenKeys(field: KnowledgeFieldsDraftField, except: number): Set<string> {
  const taken = new Set<string>(field.key === "evidence" ? KNOWLEDGE_RESERVED_EVIDENCE_KEYS : []);
  field.options.forEach((o, i) => {
    if (i !== except) taken.add(o.key);
  });
  return taken;
}

let nextUid = 0;

export function addOption(draft: KnowledgeFieldsDraft, field: FieldRef): KnowledgeFieldsDraft {
  nextUid += 1;
  const uid = nextUid;
  return mapField(draft, field, (f) => ({ ...f, options: [...f.options, { key: "", name: "", enabled: true, isNew: true, uid }] }));
}

/** `index` addresses the row; a new row's key changes while it is edited, so it can't be the identity. */
export function setOptionName(draft: KnowledgeFieldsDraft, field: FieldRef, index: number, name: string): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({
    ...f,
    options: f.options.map((o, i) => {
      if (i !== index) return o;
      if (!o.isNew || o.keyEdited) return { ...o, name };
      // A name with no ASCII letters or digits has no readable slug; keep the key rather than re-rolling a random one per keystroke.
      const hasSlug = /[a-z0-9]/i.test(name.normalize("NFKD"));
      const key = hasSlug || o.key === "" ? knowledgeKeyFromName(name, takenKeys(f, i)) : o.key;
      return { ...o, name, key };
    }),
  }));
}

export function setOptionKey(draft: KnowledgeFieldsDraft, field: FieldRef, index: number, key: string): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, options: f.options.map((o, i) => (i === index && o.isNew ? { ...o, key, keyEdited: true } : o)) }));
}

export function setOptionEnabled(draft: KnowledgeFieldsDraft, field: FieldRef, index: number, enabled: boolean): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, options: f.options.map((o, i) => (i === index ? { ...o, enabled } : o)) }));
}

export function customFields(draft: KnowledgeFieldsDraft): KnowledgeFieldsDraftField[] {
  return draft.fields.filter((f) => !f.builtin);
}

export function enabledCustomCount(draft: KnowledgeFieldsDraft): number {
  return customFields(draft).filter((f) => f.enabled).length;
}

/** The part of a custom field's key after `x-`, which is what the admin types. */
export const fieldSlug = (key: string): string => (key.startsWith("x-") ? key.slice(2) : key);

/** Slugs in use by any custom field, turned-off ones included, because a key is never reused. */
export function takenFieldSlugs(draft: KnowledgeFieldsDraft, except?: number): Set<string> {
  const taken = new Set<string>();
  draft.fields.forEach((f, i) => {
    if (!f.builtin && i !== except) taken.add(fieldSlug(f.key));
  });
  return taken;
}

/** A name with no ASCII letters or digits has no readable slug; keep the key rather than re-rolling a random one per keystroke. */
export function slugFromName(name: string, taken: ReadonlySet<string>, current: string): string {
  const hasSlug = /[a-z0-9]/i.test(name.normalize("NFKD"));
  return hasSlug || current === "" ? knowledgeKeyFromName(name, taken) : current;
}

export interface CustomFieldInput {
  name: string;
  type: KnowledgeCustomFieldType;
  /** Without the `x-` prefix. */
  key: string;
  options?: Array<{ key: string; name: string }>;
}

/** The new field starts off when the enabled limit is already reached. */
export function addCustomField(draft: KnowledgeFieldsDraft, input: CustomFieldInput): KnowledgeFieldsDraft {
  nextUid += 1;
  const uid = nextUid;
  // Keys typed in the add form must survive a later rename of the option.
  const options = input.type === "select" ? (input.options ?? []).map((o) => ({ key: o.key, name: o.name, enabled: true, isNew: true, keyEdited: true, uid: ++nextUid })) : [];
  const field: KnowledgeFieldsDraftField = {
    key: `x-${input.key}`,
    enabled: enabledCustomCount(draft) < KNOWLEDGE_CUSTOM_ENABLED_MAX,
    name: input.name,
    type: input.type,
    builtin: false,
    isNew: true,
    uid,
    options,
  };
  return { fields: [...draft.fields, field] };
}

export function setCustomName(draft: KnowledgeFieldsDraft, index: number, name: string): KnowledgeFieldsDraft {
  return mapField(draft, index, (f) => ({ ...f, name }));
}

export function setCustomKey(draft: KnowledgeFieldsDraft, index: number, slug: string): KnowledgeFieldsDraft {
  return mapField(draft, index, (f) => (f.isNew ? { ...f, key: `x-${slug}` } : f));
}

/** Swaps with the neighbouring custom field; built-in fields keep their fixed order. */
export function moveField(draft: KnowledgeFieldsDraft, field: FieldRef, by: -1 | 1): KnowledgeFieldsDraft {
  const customIdx = draft.fields.flatMap((f, i) => (f.builtin ? [] : [i]));
  const from = typeof field === "number" ? field : draft.fields.findIndex((f) => f.key === field);
  const pos = customIdx.indexOf(from);
  const to = customIdx[pos + by];
  if (pos < 0 || to === undefined) return draft;
  const fields = [...draft.fields];
  [fields[from], fields[to]] = [fields[to]!, fields[from]!];
  return { fields };
}
