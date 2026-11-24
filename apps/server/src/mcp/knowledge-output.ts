/** What `edit_note` and `create_note` report about knowledge info. Raw-shape fields only: the SDK silently drops a schema wrapped in `.refine`. */
import { z } from "zod";
import { KNOWLEDGE_IGNORE_REASONS, type KnowledgeIgnoredItem } from "@knotebook/shared";
import type { KnowledgeWriteReport } from "../notes/editing/knowledge-write.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "./limits.js";

export const KNOWLEDGE_OUTPUT_DESCRIBE =
  "Only present when your write kept, created, removed or renumbered knowledge info, or ignored a knowledge comment or a value in one. " +
  "kept: headings you sent without a comment that kept the knowledge info of the heading they replaced. " +
  "created: knowledge ids that are new to the note after your write, whether you left the id out or wrote a new one. " +
  "removed: knowledge info that was in what you replaced or deleted and is no longer in the note. " +
  "renewed: headings that wrote an id another heading in the note holds, so they got a new one; from is the id they wrote. " +
  "ignored: lines of a knowledge comment that weren't written: the heading, the key, the value you wrote and the reason; a field whose line was ignored keeps the value it had. " +
  "ignoredComments: knowledge comments that weren't right after a heading that can hold knowledge info. " +
  `Each list holds at most ${MCP_PAGE_MAX} entries; truncated is true when one was cut.`;

export const CREATE_KNOWLEDGE_OUTPUT_DESCRIBE = "Only present when your content had knowledge comments or a knowledge id was set; as in edit_note.";

const headingShape = {
  heading: z.string().max(MCP_TEXT_MAX),
  headingTruncated: z.literal(true).optional(),
};

const refSchema = z.object({ id: z.string(), ...headingShape });

const ignoredSchema = z.object({
  ...headingShape,
  key: z.string(),
  keyTruncated: z.literal(true).optional(),
  value: z.string(),
  valueTruncated: z.literal(true).optional(),
  reason: z.enum(KNOWLEDGE_IGNORE_REASONS),
});

export const knowledgeOutputSchema = z.object({
  kept: z.array(refSchema),
  created: z.array(refSchema),
  removed: z.array(refSchema),
  renewed: z.array(refSchema.extend({ from: z.string() })),
  ignored: z.array(ignoredSchema),
  ignoredComments: z.number(),
  truncated: z.boolean(),
});

export type KnowledgeForModel = z.infer<typeof knowledgeOutputSchema>;

/** Escaped size of one entry besides its heading and ids: the keys and the punctuation. */
const ENTRY_OVERHEAD = 50;
/** As `ENTRY_OVERHEAD` for an `ignored` entry: four keys, three `*Truncated` flags and the punctuation. */
const IGNORED_ENTRY_OVERHEAD = 130;
/**
 * A list can't be allowed all of `MCP_PAGE_MAX` entries at full heading length: five such lists next to a full outline page would pass the
 * wire limit (`test/mcp-size.test.ts`). Short headings, the usual case, never reach this.
 */
const LIST_BUDGET = 9_600;

function cut<T>(items: readonly T[], entry: (item: T) => { cost: number; out: Record<string, unknown> }): { list: Array<Record<string, unknown>>; truncated: boolean } {
  const list: Array<Record<string, unknown>> = [];
  let budget = LIST_BUDGET;
  for (const item of items) {
    const { cost, out } = entry(item);
    if (list.length >= MCP_PAGE_MAX || cost > budget) return { list, truncated: true };
    budget -= cost;
    list.push(out);
  }
  return { list, truncated: false };
}

function refEntry<T extends { id: string; heading: string }>(extra: (item: T) => Record<string, string>): (item: T) => { cost: number; out: Record<string, unknown> } {
  return item => {
    const heading = truncateText(item.heading);
    const more = extra(item);
    return {
      cost: escapedLength(heading.text) + escapedLength(item.id) + escapedLength(Object.values(more).join("")) + ENTRY_OVERHEAD,
      out: { id: item.id, heading: heading.text, ...(heading.truncated ? { headingTruncated: true as const } : {}), ...more },
    };
  };
}

function ignoredEntry(item: KnowledgeIgnoredItem): { cost: number; out: Record<string, unknown> } {
  const heading = truncateText(item.heading);
  const key = truncateText(item.key);
  const value = truncateText(item.value);
  return {
    cost: escapedLength(heading.text) + escapedLength(key.text) + escapedLength(value.text) + escapedLength(item.reason) + IGNORED_ENTRY_OVERHEAD,
    out: {
      heading: heading.text,
      ...(heading.truncated ? { headingTruncated: true as const } : {}),
      key: key.text,
      ...(key.truncated ? { keyTruncated: true as const } : {}),
      value: value.text,
      ...(value.truncated ? { valueTruncated: true as const } : {}),
      reason: item.reason,
    },
  };
}

export function knowledgeForModel(report: KnowledgeWriteReport): KnowledgeForModel {
  const plain = refEntry(() => ({}));
  const kept = cut(report.kept, plain);
  const created = cut(report.created, plain);
  const removed = cut(report.removed, plain);
  const renewed = cut(report.renewed, refEntry(r => ({ from: r.from })));
  const ignored = cut(report.ignored, ignoredEntry);
  return {
    kept: kept.list,
    created: created.list,
    removed: removed.list,
    renewed: renewed.list,
    ignored: ignored.list,
    ignoredComments: report.ignoredComments,
    truncated: kept.truncated || created.truncated || removed.truncated || renewed.truncated || ignored.truncated,
  } as KnowledgeForModel;
}
