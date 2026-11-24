/**
 * The CHECK constraints on note_knowledge must accept exactly what shared's constants allow, so a value the extractor keeps can never be refused by the database.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BLOCK_ANCHOR_RE, KNOWLEDGE_BUILTIN_FIELDS, KNOWLEDGE_CUSTOM_FIELD_TYPES, KNOWLEDGE_FIELD_NAME_MAX, KNOWLEDGE_ICON_KINDS, KNOWLEDGE_ID_RE, KNOWLEDGE_KEY_RE, KNOWLEDGE_RESERVED_EVIDENCE_KEYS, KNOWLEDGE_STORED_STATUSES } from "@knotebook/shared";
import { knowledgeFieldDefs, knowledgeFieldOverrides, noteKnowledge } from "../../src/db/schema.js";

const dialect = new PgDialect();
function checkSql(name: string, table: Parameters<typeof getTableConfig>[0] = noteKnowledge): string {
  const c = getTableConfig(table).checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}`);
  return dialect.sqlToQuery(c.value).sql;
}
const listed = (sqlText: string): string[] => [...sqlText.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
const pattern = (sqlText: string): string => /~ '([^']*)'/.exec(sqlText)![1]!;

describe("note_knowledge checks match shared constants", () => {
  it("nk_evidence_chk allows '' or the option key format", () => {
    expect(pattern(checkSql("nk_evidence_chk"))).toBe(KNOWLEDGE_KEY_RE.source);
    expect(listed(checkSql("nk_evidence_chk"))[0]).toBe("");
  });
  it("nk_status_chk lists '' and exactly KNOWLEDGE_STORED_STATUSES", () => {
    expect(listed(checkSql("nk_status_chk"))).toEqual(["", ...KNOWLEDGE_STORED_STATUSES]);
  });
  it("nk_icon_chk still accepts the legacy kind next to KNOWLEDGE_ICON_KINDS", () => {
    expect(listed(checkSql("nk_icon_chk")).sort()).toEqual([...KNOWLEDGE_ICON_KINDS, "noVerifiedDate"].sort());
  });
  it("nk_knowledge_id_chk's pattern accepts and rejects the same ids as KNOWLEDGE_ID_RE", () => {
    const re = new RegExp(pattern(checkSql("nk_knowledge_id_chk")));
    for (const id of ["k_0123abcd", "k_0123ABCD", "k_0123abc", "x_0123abcd", "k_0123abcde", ""]) expect(re.test(id)).toBe(KNOWLEDGE_ID_RE.test(id));
  });
  it("nk_superseded_chk uses the same id pattern", () => {
    expect(pattern(checkSql("nk_superseded_chk"))).toBe(pattern(checkSql("nk_knowledge_id_chk")));
  });
  it("nk_block_id_chk's pattern is BLOCK_ANCHOR_RE's source", () => {
    expect(pattern(checkSql("nk_block_id_chk"))).toBe(BLOCK_ANCHOR_RE.source);
  });
});

describe("knowledge field settings checks match shared constants", () => {
  it("the definition key check uses the shared key pattern", () => {
    expect(pattern(checkSql("kfd_key_chk", knowledgeFieldDefs))).toBe(KNOWLEDGE_KEY_RE.source);
  });
  it("the definition's custom field reference and the override's option key use the same key pattern", () => {
    const keyBody = KNOWLEDGE_KEY_RE.source.replace(/^\^/, "");
    expect(pattern(checkSql("kfd_field_ref_chk", knowledgeFieldDefs))).toBe(`^x-${keyBody}`);
    expect(pattern(checkSql("kfo_field_ref_chk", knowledgeFieldOverrides))).toBe(`^x-${keyBody}`);
    expect(pattern(checkSql("kfo_option_key_chk", knowledgeFieldOverrides))).toBe(KNOWLEDGE_KEY_RE.source);
  });
  it("the reserved basis keys and the builtin field list are the shared ones", () => {
    expect(listed(checkSql("kfd_reserved_chk", knowledgeFieldDefs))).toEqual(["option", "evidence", ...KNOWLEDGE_RESERVED_EVIDENCE_KEYS]);
    expect(listed(checkSql("kfo_field_ref_chk", knowledgeFieldOverrides)).slice(0, KNOWLEDGE_BUILTIN_FIELDS.length)).toEqual([...KNOWLEDGE_BUILTIN_FIELDS]);
  });
  it("the definition type check lists the custom field types", () => {
    expect(listed(checkSql("kfd_kind_type_chk", knowledgeFieldDefs)).filter((v) => KNOWLEDGE_CUSTOM_FIELD_TYPES.includes(v as never))).toEqual([...KNOWLEDGE_CUSTOM_FIELD_TYPES]);
  });
  it("the override name check uses the shared name maximum", () => {
    expect(checkSql("kfo_name_chk", knowledgeFieldOverrides)).toContain(`between 1 and ${KNOWLEDGE_FIELD_NAME_MAX}`);
  });
});
