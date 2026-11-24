// The whole site state is replaced in one transaction. Definitions are never deleted, so an option left out of the input is refused (`knowledge_fields_incomplete`): that is also what stops two admins from overwriting each other's additions.
// Only differences from the built-in defaults are stored, so saving the defaults back leaves no override rows.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  KNOWLEDGE_BUILTIN_FIELDS,
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

function checkName(name: string): string {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > KNOWLEDGE_FIELD_NAME_MAX || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(trimmed)) {
    throw invalid(`A name must be 1 to ${KNOWLEDGE_FIELD_NAME_MAX} characters without line breaks.`);
  }
  return trimmed;
}

function checkFields(input: SiteKnowledgeFieldsInput): Map<string, KnowledgeFieldInput> {
  const byKey = new Map<string, KnowledgeFieldInput>();
  for (const field of input.fields) {
    if (field.key.startsWith("x-")) throw invalid("Custom fields are not available yet.");
    if (!BUILTIN_SET.has(field.key)) throw invalid(`Unknown field "${field.key.slice(0, 80)}".`);
    if (byKey.has(field.key)) throw invalid(`The field "${field.key}" is listed twice.`);
    if (field.name !== undefined && field.name !== null) throw invalid("A built-in field cannot be renamed.");
    if (field.type !== undefined) throw invalid("A built-in field has a fixed type.");
    if (field.options !== undefined && field.key !== "evidence") throw invalid(`The field "${field.key}" has no options.`);
    byKey.set(field.key, field);
  }
  const missing = KNOWLEDGE_BUILTIN_FIELDS.filter((key) => !byKey.has(key));
  if (missing.length > 0) throw new TxAbort(400, "knowledge_fields_incomplete", `Every built-in field must be listed; missing: ${missing.join(", ")}.`);
  if (byKey.get("evidence")!.options === undefined) throw new TxAbort(400, "knowledge_fields_incomplete", "The basis field must list all of its options.");
  return byKey;
}

function checkOptions(options: readonly KnowledgeOptionInput[]): void {
  if (options.length > KNOWLEDGE_OPTIONS_MAX) throw new TxAbort(400, "knowledge_fields_limit", `A field can have at most ${KNOWLEDGE_OPTIONS_MAX} options.`);
  const seen = new Set<string>();
  for (const option of options) {
    if (!KNOWLEDGE_KEY_RE.test(option.key) || (RESERVED.has(option.key) && !isBuiltinOption(option.key))) {
      throw new TxAbort(400, "knowledge_key_invalid", "An option key must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, and not a reserved word.");
    }
    if (seen.has(option.key)) throw new TxAbort(400, "knowledge_key_taken", `The option key "${option.key}" is listed twice.`);
    seen.add(option.key);
  }
}

export async function writeSiteKnowledgeFieldsInTx(tx: Tx, input: SiteKnowledgeFieldsInput): Promise<AdminKnowledgeFieldsDto> {
  const byKey = checkFields(input);
  const options = byKey.get("evidence")!.options!;
  checkOptions(options);

  // Two admins saving at once queue here; the second then sees the first's new options and is refused as incomplete if it lacks them.
  await tx.execute(sql`lock table ${knowledgeFieldDefs}, ${knowledgeFieldOverrides} in share row exclusive mode`);

  const existingDefs = await tx
    .select({ key: knowledgeFieldDefs.key })
    .from(knowledgeFieldDefs)
    .where(and(eq(knowledgeFieldDefs.kind, "option"), eq(knowledgeFieldDefs.fieldRef, "evidence")));
  const defined = new Set<string>(existingDefs.map((d) => d.key));
  const given = new Set(options.map((o) => o.key));
  const absent = [...BUILTIN_OPTIONS, ...defined].filter((key) => !given.has(key));
  if (absent.length > 0) throw new TxAbort(400, "knowledge_fields_incomplete", `Every existing option must be listed; missing: ${absent.join(", ")}.`);

  const names = new Map<string, string | null>();
  for (const option of options) {
    if (option.name === null) {
      if (!isBuiltinOption(option.key)) throw invalid(`The option "${option.key}" needs a name.`);
      names.set(option.key, null);
    } else {
      names.set(option.key, checkName(option.name));
    }
  }

  const created = options.filter((o) => !isBuiltinOption(o.key) && !defined.has(o.key));
  if (created.length > 0) {
    await tx.insert(knowledgeFieldDefs).values(created.map((o) => ({ kind: "option", fieldRef: "evidence", key: o.key, type: null, originKind: "site" })));
  }

  type OverrideInsert = typeof knowledgeFieldOverrides.$inferInsert;
  const rows: OverrideInsert[] = [];
  for (const key of KNOWLEDGE_BUILTIN_FIELDS) {
    if (!byKey.get(key)!.enabled) rows.push({ groupId: null, fieldRef: key, optionKey: "", enabled: false, name: null, position: null });
  }
  options.forEach((option, index) => {
    const defaultPosition = (BUILTIN_OPTIONS as readonly string[]).indexOf(option.key);
    const name = names.get(option.key) ?? null;
    const position = index === defaultPosition ? null : index;
    if (defaultPosition !== -1 && option.enabled && name === null && position === null) return;
    rows.push({ groupId: null, fieldRef: "evidence", optionKey: option.key, enabled: option.enabled ? null : false, name, position });
  });

  await tx
    .delete(knowledgeFieldOverrides)
    .where(and(isNull(knowledgeFieldOverrides.groupId), inArray(knowledgeFieldOverrides.fieldRef, [...KNOWLEDGE_BUILTIN_FIELDS])));
  if (rows.length > 0) await tx.insert(knowledgeFieldOverrides).values(rows);

  return loadAdminKnowledgeFields(tx);
}
