// The sentences about knowledge info in the tool strings are the ones in docs/mcp.md, word for word, and say only what the code does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CREATE_KNOWLEDGE_OUTPUT_DESCRIBE, KNOWLEDGE_OUTPUT_DESCRIBE, knowledgeForModel, knowledgeOutputSchema } from "../../src/mcp/knowledge-output.js";
import {
  CREATE_KNOWLEDGE_SENTENCE,
  EDIT_TAG_SENTENCE,
  INVALID_KNOWLEDGE_ERROR_SENTENCE,
  OUTLINE_TAGS_DESCRIBE,
  READ_SECTION_KNOWLEDGE_SENTENCE,
  WRITE_KNOWLEDGE_SENTENCE,
} from "../../src/mcp/knowledge-strings.js";
import {
  CREATE_KNOWLEDGE_FIELDS_DESCRIBE,
  KNOWLEDGE_FIELDS_DESCRIBE,
  KNOWLEDGE_FIELDS_OUTLINE_BUDGET,
  KNOWLEDGE_FIELDS_REPLY_BUDGET,
  knowledgeFieldsForModel,
  knowledgeFieldsOutputSchema,
} from "../../src/mcp/knowledge-fields-output.js";
import { MCP_PAGE_MAX, escapedLength } from "../../src/mcp/limits.js";
import { createNoteInput, createNoteOutput } from "../../src/mcp/tools/create-note.js";
import { editNoteInput, editNoteOutput } from "../../src/mcp/tools/edit-note.js";
import { READ_NOTE_SECTION_DESCRIPTION } from "../../src/mcp/tools/read-note-section.js";
import { readNoteOutlineOutput } from "../../src/mcp/tools/read-note-outline.js";
import { emptyKnowledgeReport } from "../../src/notes/editing/knowledge-write.js";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, resolveKnowledgeFieldView, type KnowledgeFieldDefRow, type KnowledgeFieldOverrideRow } from "@knotebook/shared";

const docs = readFileSync(new URL("../../../../docs/mcp.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const describeOf = (schema: z.ZodTypeAny): string => schema.description ?? "";

describe("knowledge sentences in the tool strings", () => {
  it("each new sentence appears verbatim in docs/mcp.md", () => {
    for (const s of [
      READ_SECTION_KNOWLEDGE_SENTENCE,
      WRITE_KNOWLEDGE_SENTENCE,
      EDIT_TAG_SENTENCE,
      CREATE_KNOWLEDGE_SENTENCE,
      OUTLINE_TAGS_DESCRIBE,
      KNOWLEDGE_OUTPUT_DESCRIBE,
      CREATE_KNOWLEDGE_OUTPUT_DESCRIBE,
      INVALID_KNOWLEDGE_ERROR_SENTENCE,
      KNOWLEDGE_FIELDS_DESCRIBE,
      CREATE_KNOWLEDGE_FIELDS_DESCRIBE,
    ]) {
      expect(docs, s.slice(0, 60)).toContain(s);
    }
  });

  it("they are the strings the tools carry", () => {
    expect(describeOf(readNoteOutlineOutput.knowledgeFields)).toBe(KNOWLEDGE_FIELDS_DESCRIBE);
    expect(describeOf(createNoteOutput.knowledgeFields)).toBe(CREATE_KNOWLEDGE_FIELDS_DESCRIBE);
    expect(READ_NOTE_SECTION_DESCRIPTION.endsWith(` ${READ_SECTION_KNOWLEDGE_SENTENCE}`)).toBe(true);
    expect(describeOf(editNoteInput.markdown)).toContain(` ${WRITE_KNOWLEDGE_SENTENCE} ${EDIT_TAG_SENTENCE}`);
    expect(describeOf(createNoteInput.content)).toContain(` ${CREATE_KNOWLEDGE_SENTENCE}`);
    expect(describeOf(editNoteOutput.knowledge)).toBe(KNOWLEDGE_OUTPUT_DESCRIBE);
    expect(describeOf(createNoteOutput.knowledge)).toBe(CREATE_KNOWLEDGE_OUTPUT_DESCRIBE);
    expect(describeOf((readNoteOutlineOutput.note as unknown as z.ZodObject<{ tags: z.ZodTypeAny }>).shape.tags)).toBe(OUTLINE_TAGS_DESCRIBE);
  });

  it("the write sentence names only id and status and points to the outline for the other fields", () => {
    expect(WRITE_KNOWLEDGE_SENTENCE).not.toMatch(/tested|unconfirmed|conclusion|superseded_by|evidence/);
    expect(WRITE_KNOWLEDGE_SENTENCE).toMatch(/verified, needs-verify or obsolete/);
    expect(WRITE_KNOWLEDGE_SENTENCE).toContain("knowledgeFields");
    expect(WRITE_KNOWLEDGE_SENTENCE).toContain("knowledge.ignored");
    expect(INVALID_KNOWLEDGE_ERROR_SENTENCE).not.toMatch(/value|evidence|status|date/);
  });

  it("leaving out a line empties only a field the outline lists, and the read sentence points to the outline for the fields", () => {
    expect(WRITE_KNOWLEDGE_SENTENCE).not.toContain("any line other than id");
    expect(WRITE_KNOWLEDGE_SENTENCE).toContain("leave out a line to empty that field, except id and status (below) and a field read_note_outline doesn't list, which keeps its value");
    expect(READ_SECTION_KNOWLEDGE_SENTENCE).toContain("the fields read_note_outline lists under knowledgeFields");
    expect(READ_SECTION_KNOWLEDGE_SENTENCE).not.toMatch(/tested|conclusion|superseded_by|evidence/);
  });

  it("the field definitions' describe text names the type values the schema allows", () => {
    for (const t of knowledgeFieldsOutputSchema.shape.fields.element.shape.type.options) expect(KNOWLEDGE_FIELDS_DESCRIBE).toContain(t);
  });

  it("the output's describe text names the ignored list", () => {
    expect(KNOWLEDGE_OUTPUT_DESCRIBE).toContain("ignored: ");
  });

  it("the output's wording matches its limits: the list cap is the page size", () => {
    expect(KNOWLEDGE_OUTPUT_DESCRIBE).toContain(`at most ${MCP_PAGE_MAX} entries`);
  });
});

describe("knowledgeForModel", () => {
  const ref = (n: number, heading = `H${n}`) => ({ id: `k_${String(n).padStart(8, "0")}`, heading });

  it("cuts each list at 100 entries and says so", () => {
    const report = { ...emptyKnowledgeReport(), removed: Array.from({ length: 120 }, (_, i) => ref(i)) };
    const out = knowledgeForModel(report);
    expect(out.removed).toHaveLength(100);
    expect(out.kept).toHaveLength(0);
    expect(out.truncated).toBe(true);
    expect(knowledgeOutputSchema.safeParse(out).success).toBe(true);
  });

  it("is not truncated when every list fits, and carries from on renewed", () => {
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), renewed: [{ ...ref(1), from: "k_00000009" }], ignoredComments: 2 });
    expect(out).toEqual({ kept: [], created: [], removed: [], renewed: [{ id: "k_00000001", heading: "H1", from: "k_00000009" }], ignored: [], ignoredComments: 2, truncated: false });
  });

  it("cuts a heading at 200 characters as written in JSON and marks it, leaving short ones unmarked", () => {
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), created: [ref(1, "x".repeat(300)), ref(2, "short")] });
    expect(out.created[0]!.heading).toHaveLength(200);
    expect(out.created[0]!.headingTruncated).toBe(true);
    expect("headingTruncated" in out.created[1]!).toBe(false);
    const quoted = knowledgeForModel({ ...emptyKnowledgeReport(), created: [ref(1, '"'.repeat(150))] });
    expect(quoted.created[0]!.heading).toHaveLength(100);
  });

  it("an id counts toward a list's budget, so a very long id cuts the list short", () => {
    const longId = (n: number) => ({ id: `k_${String(n).padStart(8, "0")}${"z".repeat(5_000)}`, heading: "h" });
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), kept: Array.from({ length: 100 }, (_, i) => longId(i)) });
    expect(out.truncated).toBe(true);
    expect(out.kept.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(out).length).toBeLessThan(13_000 + 1_000);
  });

  it("long headings use a list's wire budget before its 100 entries, so four full lists stay under the wire limit", () => {
    const long = (n: number) => ref(n, "y".repeat(200));
    const all = Array.from({ length: 100 }, (_, i) => long(i));
    const out = knowledgeForModel({ kept: all, created: all, removed: all, renewed: all.map(r => ({ ...r, from: "k_00000000" })), ignored: [], ignoredComments: 0 });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(56_000);
    for (const list of [out.kept, out.created, out.removed, out.renewed]) expect(list.length).toBeGreaterThan(30);
  });

  it("an ignored entry carries heading, key, value and reason, and cuts the heading, key and value at 200 characters as written in JSON", () => {
    const out = knowledgeForModel({
      ...emptyKnowledgeReport(),
      ignored: [
        { heading: "Alpha", key: "evidence", value: "vendor-doc", reason: "not_an_option" },
        { heading: "h".repeat(300), key: "k".repeat(300), value: '"'.repeat(150), reason: "unknown_field" },
      ],
    });
    expect(out.truncated).toBe(false);
    expect(out.ignored[0]).toEqual({ heading: "Alpha", key: "evidence", value: "vendor-doc", reason: "not_an_option" });
    expect(out.ignored[1]).toEqual({ heading: "h".repeat(200), headingTruncated: true, key: "k".repeat(200), keyTruncated: true, value: '"'.repeat(100), valueTruncated: true, reason: "unknown_field" });
    expect(knowledgeOutputSchema.safeParse(out).success).toBe(true);
  });

  it("the ignored list is cut by its own budget, so a long list of long values stops before 100 entries", () => {
    const item = (n: number) => ({ heading: `${n}${'"'.repeat(200)}`, key: '"'.repeat(80), value: '"'.repeat(200), reason: "bad_date" as const });
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), ignored: Array.from({ length: 100 }, (_, i) => item(i)) });
    expect(out.truncated).toBe(true);
    expect(out.ignored.length).toBeGreaterThan(5);
    expect(out.ignored.length).toBeLessThan(100);
    expect(JSON.stringify(out.ignored).length).toBeLessThan(9_600 + 1_000);
  });
});

describe("knowledgeFieldsForModel", () => {
  const site = (rows: Array<Partial<KnowledgeFieldOverrideRow> & Pick<KnowledgeFieldOverrideRow, "fieldRef">>): KnowledgeFieldOverrideRow[] =>
    rows.map(r => ({ optionKey: "", enabled: null, name: null, position: null, ...r }));
  const option = (key: string, i: number): KnowledgeFieldDefRow => ({ kind: "option", fieldRef: "evidence", key, type: null, createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });

  it("the default view lists the three statuses and all five fields with English names, and the basis options", () => {
    const out = knowledgeFieldsForModel(DEFAULT_KNOWLEDGE_FIELD_VIEW, KNOWLEDGE_FIELDS_OUTLINE_BUDGET);
    expect(out).toEqual({
      status: ["verified", "needs-verify", "obsolete"],
      fields: [
        { key: "when", name: "When to read", type: "text" },
        { key: "conclusion", name: "Conclusion", type: "text" },
        { key: "evidence", name: "Basis", type: "select", options: [{ key: "tested", name: "Tested" }, { key: "docs", name: "Documentation" }, { key: "inferred", name: "Inferred" }] },
        { key: "verified", name: "Last verified", type: "date" },
        { key: "superseded_by", name: "Replaced by", type: "ref" },
      ],
    });
    expect(knowledgeFieldsOutputSchema.safeParse(out).success).toBe(true);
  });

  it("leaves out a turned-off field and a turned-off option, and uses a renamed option's stored name", () => {
    const view = resolveKnowledgeFieldView({
      defs: [option("vendor-doc", 1)],
      site: site([
        { fieldRef: "conclusion", enabled: false },
        { fieldRef: "evidence", optionKey: "docs", enabled: false },
        { fieldRef: "evidence", optionKey: "tested", name: "Ran it" },
        { fieldRef: "evidence", optionKey: "vendor-doc", name: "Vendor docs", position: 3 },
      ]),
    });
    const out = knowledgeFieldsForModel(view, KNOWLEDGE_FIELDS_OUTLINE_BUDGET);
    expect(out.fields.map(f => f.key)).toEqual(["when", "evidence", "verified", "superseded_by"]);
    expect(out.fields[1]!.options).toEqual([{ key: "tested", name: "Ran it" }, { key: "inferred", name: "Inferred" }, { key: "vendor-doc", name: "Vendor docs" }]);
    expect("optionsTruncated" in out.fields[1]!).toBe(false);
  });

  it("over its budget it cuts options from the end and marks the field, staying within the budget", () => {
    const keys = Array.from({ length: 27 }, (_, i) => `o${String(i).padStart(2, "0")}${"a".repeat(61)}`);
    const quoted = '"'.repeat(60);
    const view = resolveKnowledgeFieldView({
      defs: keys.map(option),
      site: site([...["tested", "docs", "inferred", ...keys].map((k, i) => ({ fieldRef: "evidence" as const, optionKey: k, name: quoted, position: i }))]),
    });
    const full = knowledgeFieldsForModel(view, KNOWLEDGE_FIELDS_OUTLINE_BUDGET);
    expect(full.fields[2]!.options).toHaveLength(30);
    const fullSize = escapedLength(JSON.stringify(full));
    expect(fullSize).toBeLessThan(KNOWLEDGE_FIELDS_REPLY_BUDGET);
    const budget = fullSize - 1_000;
    const cut = knowledgeFieldsForModel(view, budget);
    expect(cut.fields[2]!.optionsTruncated).toBe(true);
    expect(cut.fields[2]!.options!.length).toBeLessThan(30);
    expect(cut.fields[2]!.options).toEqual(full.fields[2]!.options!.slice(0, cut.fields[2]!.options!.length));
    expect(escapedLength(JSON.stringify(cut))).toBeLessThanOrEqual(budget);
    expect(knowledgeFieldsOutputSchema.safeParse(cut).success).toBe(true);
    const tiny = knowledgeFieldsForModel(view, 10);
    expect(tiny.fields[2]).toEqual({ key: "evidence", name: "Basis", type: "select", options: [], optionsTruncated: true });
    expect(tiny.fields).toHaveLength(5);
  });
});
