// The whole site state is replaced in one transaction. Definitions are never deleted, so a field or option left out of the input is refused (`knowledge_fields_incomplete`): that is also what stops two admins from overwriting each other's additions.
// Only differences from the built-in defaults are stored, so saving the defaults back leaves no override rows.
import { isNull, sql } from "drizzle-orm";
import {
  KNOWLEDGE_BUILTIN_FIELDS,
  KNOWLEDGE_CUSTOM_ENABLED_MAX,
  KNOWLEDGE_CUSTOM_TOTAL_MAX,
  KNOWLEDGE_FIELD_NAME_MAX,
  KNOWLEDGE_KEY_RE,
  KNOWLEDGE_OPTIONS_MAX,
  KNOWLEDGE_RESERVED_EVIDENCE_KEYS,
  type AdminKnowledgeFieldsDto,
  type KnowledgeFieldInput,
  type KnowledgeOptionInput,
  type SiteKnowledgeFieldsInput,
} from "@knotebook/shared";
import { knowledgeFieldDefs, knowledgeFieldOverrides } from "../../../db/schema.js";
import type { Tx } from "../../../db/tx.js";
import { TxAbort } from "../../../http/tx-abort.js";
import { loadAdminKnowledgeFields } from "../queries.js";

// Same order and positions as the built-in basis options in shared's view resolution.
const BUILTIN_OPTIONS = ["tested", "docs", "inferred"] as const;
const BUILTIN_SET: ReadonlySet<string> = new Set(KNOWLEDGE_BUILTIN_FIELDS);
const RESERVED: ReadonlySet<string> = new Set(KNOWLEDGE_RESERVED_EVIDENCE_KEYS);

const isBuiltinOption = (key: string): boolean => (BUILTIN_OPTIONS as readonly string[]).includes(key);
const invalid = (message: string): TxAbort => new TxAbort(400, "invalid_body", message);
const incomplete = (message: string): TxAbort => new TxAbort(400, "knowledge_fields_incomplete", message);

function checkName(name: string): string {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > KNOWLEDGE_FIELD_NAME_MAX || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(trimmed)) {
    throw invalid(`A name must be 1 to ${KNOWLEDGE_FIELD_NAME_MAX} characters without line breaks.`);
  }
  return trimmed;
}

const isCustomKey = (key: string): boolean => key.startsWith("x-");

function checkFields(input: SiteKnowledgeFieldsInput): { byKey: Map<string, KnowledgeFieldInput>; custom: KnowledgeFieldInput[] } {
  const byKey = new Map<string, KnowledgeFieldInput>();
  const custom: KnowledgeFieldInput[] = [];
  for (const field of input.fields) {
    if (byKey.has(field.key)) throw invalid(`The field "${field.key.slice(0, 80)}" is listed twice.`);
    if (isCustomKey(field.key)) {
      if (!KNOWLEDGE_KEY_RE.test(field.key.slice(2))) {
        throw new TxAbort(400, "knowledge_key_invalid", "A field key must be x- followed by lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters.");
      }
      custom.push(field);
    } else {
      if (!BUILTIN_SET.has(field.key)) throw invalid(`Unknown field "${field.key.slice(0, 80)}".`);
      if (field.name !== undefined && field.name !== null) throw invalid("A built-in field cannot be renamed.");
      if (field.type !== undefined) throw invalid("A built-in field has a fixed type.");
      if (field.options !== undefined && field.key !== "evidence") throw invalid(`The field "${field.key}" has no options.`);
    }
    byKey.set(field.key, field);
  }
  const missing = KNOWLEDGE_BUILTIN_FIELDS.filter((key) => !byKey.has(key));
  if (missing.length > 0) throw incomplete(`Every built-in field must be listed; missing: ${missing.join(", ")}.`);
  if (byKey.get("evidence")!.options === undefined) throw incomplete("The basis field must list all of its options.");
  return { byKey, custom };
}

function checkOptions(options: readonly KnowledgeOptionInput[], reservedWords: boolean): void {
  if (options.length > KNOWLEDGE_OPTIONS_MAX) throw new TxAbort(400, "knowledge_fields_limit", `A field can have at most ${KNOWLEDGE_OPTIONS_MAX} options.`);
  const seen = new Set<string>();
  for (const option of options) {
    if (!KNOWLEDGE_KEY_RE.test(option.key) || (reservedWords && RESERVED.has(option.key) && !isBuiltinOption(option.key))) {
      throw new TxAbort(400, "knowledge_key_invalid", "An option key must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, and not a reserved word.");
    }
    if (seen.has(option.key)) throw new TxAbort(400, "knowledge_key_taken", `The option key "${option.key}" is listed twice.`);
    seen.add(option.key);
  }
}

type OverrideInsert = typeof knowledgeFieldOverrides.$inferInsert;

function planOptions(
  fieldRef: string,
  options: readonly KnowledgeOptionInput[],
  defined: ReadonlySet<string>,
  builtinKeys: readonly string[],
): { rows: OverrideInsert[]; created: Array<typeof knowledgeFieldDefs.$inferInsert> } {
  const given = new Set(options.map((o) => o.key));
  const absent = [...builtinKeys, ...defined].filter((key) => !given.has(key));
  if (absent.length > 0) throw incomplete(`Every existing option of "${fieldRef}" must be listed; missing: ${absent.join(", ")}.`);

  const rows: OverrideInsert[] = [];
  const created: Array<typeof knowledgeFieldDefs.$inferInsert> = [];
  options.forEach((option, index) => {
    const builtin = builtinKeys.includes(option.key);
    let name: string | null;
    if (option.name === null) {
      if (!builtin) throw invalid(`The option "${option.key}" needs a name.`);
      name = null;
    } else {
      name = checkName(option.name);
    }
    if (!builtin && !defined.has(option.key)) created.push({ kind: "option", fieldRef, key: option.key, type: null, originKind: "site" });
    const defaultPosition = builtinKeys.indexOf(option.key);
    const position = index === defaultPosition ? null : index;
    if (builtin && option.enabled && name === null && position === null) return;
    rows.push({ groupId: null, fieldRef, optionKey: option.key, enabled: option.enabled ? null : false, name, position });
  });
  return { rows, created };
}

export async function writeSiteKnowledgeFieldsInTx(tx: Tx, input: SiteKnowledgeFieldsInput): Promise<AdminKnowledgeFieldsDto> {
  const { byKey, custom } = checkFields(input);
  checkOptions(byKey.get("evidence")!.options!, true);

  // Two admins saving at once queue here; the second then sees the first's new definitions and is refused as incomplete if it lacks them.
  await tx.execute(sql`lock table ${knowledgeFieldDefs}, ${knowledgeFieldOverrides} in share row exclusive mode`);

  const existingDefs = await tx.select({ kind: knowledgeFieldDefs.kind, fieldRef: knowledgeFieldDefs.fieldRef, key: knowledgeFieldDefs.key, type: knowledgeFieldDefs.type }).from(knowledgeFieldDefs);
  const definedFields = new Map<string, string | null>();
  const definedOptions = new Map<string, Set<string>>();
  for (const d of existingDefs) {
    if (d.kind === "field") definedFields.set(d.fieldRef, d.type);
    else {
      const set = definedOptions.get(d.fieldRef) ?? new Set<string>();
      set.add(d.key);
      definedOptions.set(d.fieldRef, set);
    }
  }

  const absentFields = [...definedFields.keys()].filter((ref) => !byKey.has(ref));
  if (absentFields.length > 0) throw incomplete(`Every existing custom field must be listed; missing: ${absentFields.join(", ")}.`);
  if (custom.length > KNOWLEDGE_CUSTOM_TOTAL_MAX) throw new TxAbort(400, "knowledge_fields_limit", `There can be at most ${KNOWLEDGE_CUSTOM_TOTAL_MAX} custom fields, including turned-off ones.`);
  if (custom.filter((f) => f.enabled).length > KNOWLEDGE_CUSTOM_ENABLED_MAX) {
    throw new TxAbort(400, "knowledge_fields_limit", `At most ${KNOWLEDGE_CUSTOM_ENABLED_MAX} custom fields can be turned on.`);
  }

  const rows: OverrideInsert[] = [];
  const createdFields: Array<typeof knowledgeFieldDefs.$inferInsert> = [];
  const createdOptions: Array<typeof knowledgeFieldDefs.$inferInsert> = [];

  for (const key of KNOWLEDGE_BUILTIN_FIELDS) {
    if (!byKey.get(key)!.enabled) rows.push({ groupId: null, fieldRef: key, optionKey: "", enabled: false, name: null, position: null });
  }
  const evidence = planOptions("evidence", byKey.get("evidence")!.options!, definedOptions.get("evidence") ?? new Set(), BUILTIN_OPTIONS);
  rows.push(...evidence.rows);
  createdOptions.push(...evidence.created);

  custom.forEach((field, index) => {
    const existingType = definedFields.get(field.key);
    const isNew = existingType === undefined;
    if (field.name === undefined || field.name === null) throw invalid(`The custom field "${field.key}" needs a name.`);
    const name = checkName(field.name);
    if (isNew) {
      if (field.type === undefined) throw invalid(`The new custom field "${field.key}" needs a type.`);
      createdFields.push({ kind: "field", fieldRef: field.key, key: field.key.slice(2), type: field.type, originKind: "site" });
    } else if (field.type !== undefined && field.type !== existingType) {
      throw invalid(`The type of "${field.key}" cannot be changed.`);
    }
    const type = isNew ? field.type! : existingType;
    if (type === "select") {
      if (field.options === undefined) throw incomplete(`The select field "${field.key}" must list all of its options.`);
      checkOptions(field.options, false);
      const planned = planOptions(field.key, field.options, definedOptions.get(field.key) ?? new Set(), []);
      rows.push(...planned.rows);
      createdOptions.push(...planned.created);
    } else if (field.options !== undefined) {
      throw invalid(`The field "${field.key}" has no options.`);
    }
    rows.push({ groupId: null, fieldRef: field.key, optionKey: "", enabled: field.enabled ? null : false, name, position: index });
  });

  const newDefs = [...createdFields, ...createdOptions];
  if (newDefs.length > 0) await tx.insert(knowledgeFieldDefs).values(newDefs);

  await tx.delete(knowledgeFieldOverrides).where(isNull(knowledgeFieldOverrides.groupId));
  if (rows.length > 0) await tx.insert(knowledgeFieldOverrides).values(rows);

  return loadAdminKnowledgeFields(tx);
}
