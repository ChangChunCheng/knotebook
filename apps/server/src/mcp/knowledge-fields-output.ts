import { z } from "zod";
import { KNOWLEDGE_STATES, type KnowledgeBuiltinFieldKey, type KnowledgeFieldView } from "@knotebook/shared";
import { escapedLength } from "./limits.js";

export const KNOWLEDGE_FIELDS_OUTLINE_BUDGET = 40_000;
/** Lower than the outline's: the same reply can carry five full knowledge lists (`test/mcp-size.test.ts`). */
export const KNOWLEDGE_FIELDS_REPLY_BUDGET = 20_000;

export const KNOWLEDGE_FIELDS_DESCRIBE =
  "Only on the first page (section_offset left out or 0). The knowledge info fields this note's space has turned on: the keys a knowledge comment can hold besides id and status. " +
  "status lists the values status takes. Each field has its key, name and type (text, select, date, link, member, or ref: a knowledge id, or <note id>#<knowledge id> for another note); " +
  "a select field lists its options, whose keys are what you write. optionsTruncated is true on a field whose options were cut short to keep the reply small; the options left out still exist.";

export const CREATE_KNOWLEDGE_FIELDS_DESCRIBE = "The knowledge info fields of the new note's space, as read_note_outline's knowledgeFields lists them.";

const optionSchema = z.object({ key: z.string(), name: z.string() });

export const knowledgeFieldsOutputSchema = z.object({
  status: z.array(z.enum(KNOWLEDGE_STATES)),
  fields: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      type: z.enum(["text", "select", "date", "link", "member", "ref"]),
      options: z.array(optionSchema).optional(),
      optionsTruncated: z.literal(true).optional(),
    }),
  ),
});

export type KnowledgeFieldsForModel = z.infer<typeof knowledgeFieldsOutputSchema>;

// MCP strings are English; the web app names these through i18n.
const BUILTIN_FIELD_NAMES: Record<KnowledgeBuiltinFieldKey, string> = {
  when: "When to read",
  conclusion: "Conclusion",
  evidence: "Basis",
  verified: "Last verified",
  superseded_by: "Replaced by",
};
const BUILTIN_OPTION_NAMES: Record<string, string> = { tested: "Tested", docs: "Documentation", inferred: "Inferred" };

const sizeOf = (out: KnowledgeFieldsForModel): number => escapedLength(JSON.stringify(out));

/** Enabled fields and enabled options only; English default names for builtins. `budget` is in JSON-escaped units of the serialized result; over it, options are cut starting from the last field. */
export function knowledgeFieldsForModel(view: KnowledgeFieldView, budget: number): KnowledgeFieldsForModel {
  const fields: KnowledgeFieldsForModel["fields"] = view.fields
    .filter(f => f.enabled)
    .map(f => {
      const name = f.builtin ? BUILTIN_FIELD_NAMES[f.key as KnowledgeBuiltinFieldKey] : (f.name ?? f.key);
      const field: KnowledgeFieldsForModel["fields"][number] = { key: f.key, name, type: f.type };
      if (f.options) field.options = f.options.filter(o => o.enabled).map(o => ({ key: o.key, name: o.name ?? BUILTIN_OPTION_NAMES[o.key] ?? o.key }));
      return field;
    });
  const out: KnowledgeFieldsForModel = { status: [...KNOWLEDGE_STATES], fields };
  let size = sizeOf(out);
  for (let i = fields.length - 1; i >= 0 && size > budget; i--) {
    const options = fields[i]!.options;
    if (!options || options.length === 0) continue;
    // Counted before cutting, so adding the flag can't push the result back over.
    size += escapedLength(',"optionsTruncated":true');
    fields[i]!.optionsTruncated = true;
    while (options.length > 0 && size > budget) {
      const dropped = options.pop()!;
      size -= escapedLength(JSON.stringify(dropped)) + (options.length > 0 ? 1 : 0);
    }
  }
  return out;
}
