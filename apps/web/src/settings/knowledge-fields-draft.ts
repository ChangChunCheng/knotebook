import {
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  knowledgeKeyFromName,
  type AdminKnowledgeFieldsDto,
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
}
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
      if (!f.builtin) out.name = f.name.trim() === "" ? null : f.name.trim();
      if (f.type === "select") out.options = f.options.map((o) => ({ key: o.key, name: o.name.trim() === "" ? null : o.name.trim(), enabled: o.enabled }));
      return out;
    }),
  };
}

function mapField(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, fn: (f: KnowledgeFieldsDraftField) => KnowledgeFieldsDraftField): KnowledgeFieldsDraft {
  return { fields: draft.fields.map((f) => (f.key === field ? fn(f) : f)) };
}

export function setFieldEnabled(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, enabled: boolean): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, enabled }));
}

export function moveOption(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, from: number, by: -1 | 1): KnowledgeFieldsDraft {
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

export function addOption(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey): KnowledgeFieldsDraft {
  nextUid += 1;
  const uid = nextUid;
  return mapField(draft, field, (f) => ({ ...f, options: [...f.options, { key: "", name: "", enabled: true, isNew: true, uid }] }));
}

/** `index` addresses the row; a new row's key changes while it is edited, so it can't be the identity. */
export function setOptionName(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, index: number, name: string): KnowledgeFieldsDraft {
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

export function setOptionKey(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, index: number, key: string): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, options: f.options.map((o, i) => (i === index && o.isNew ? { ...o, key, keyEdited: true } : o)) }));
}

export function setOptionEnabled(draft: KnowledgeFieldsDraft, field: KnowledgeFieldKey, index: number, enabled: boolean): KnowledgeFieldsDraft {
  return mapField(draft, field, (f) => ({ ...f, options: f.options.map((o, i) => (i === index ? { ...o, enabled } : o)) }));
}
