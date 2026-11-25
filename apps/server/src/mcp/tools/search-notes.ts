/**
 * Never use the query as a LIKE/ILIKE pattern (`%`/`_` would be wildcards); the trigram path
 * escapes it with `escapeLike`. No cursor paging: the leading ORDER BY key is rank. Matches
 * are added in note order until the next would exceed `MCP_SEARCH_WIRE_BUDGET` (50 notes × 3
 * matches ≈ 328 000 can exceed the 262 144 sentinel); the first match that would exceed it
 * stops the loop (no skip-and-retry) and sets top-level `matchesTruncated: true`. List and
 * matches come from one REPEATABLE READ READ ONLY transaction. Two variants by `canRead`
 * (`collab && editing` at registration): without read tools, the description and `sectionId`
 * don't mention read_note_section/outline. `matchedOn` is per note (one top-level value means
 * nothing for a mixed list). Uses its own `search` limiter, charged before the query; it
 * doesn't touch `contentRead`.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseSearchTerms, SEARCH_TERMS_MAX, SEARCH_TERMS_MODES } from "@knotebook/shared";
import { noNul } from "../../notes/schemas.js";
import { groupMatchesByNote, matchedTermsOf, searchNotesForUser, snippetWindowOf } from "../../notes/search-query.js";
import { SEARCH_MATCHES_PER_NOTE, type NoteSearchRow, type SearchMatchRow } from "../../notes/search-sql.js";
import { buildSnippet } from "../../notes/search-snippet.js";
import { noteSummariesForModel, noteSummarySchema, type NoteSummaryForModel } from "../dto.js";
import { MCP_SEARCH_WIRE_BUDGET, MCP_SNIPPET_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "../limits.js";
import { toolError, toolResult } from "../tool-result.js";
import { wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 200;
/** `,"matchesTruncated":true` in both copies is about 50 (24 + 26). */
const MATCHES_TRUNCATED_RESERVE = 64;

// Model-facing: only say things true on every deployment shape (pinned in test/mcp-search.test.ts).
const DESC_HEAD =
  "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. " +
  "Separate keywords with spaces (there is no word segmentation, so CJK keywords need spaces too) and put a phrase in double quotes; " +
  `up to ${SEARCH_TERMS_MAX} keywords. By default a note must contain every keyword, each in its title or body; set \`terms\` to \`any\` to match any of them. ` +
  "Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body; " +
  "with several keywords, notes containing more of them come first. ";
export const SEARCH_NOTES_DESCRIPTION_READ =
  DESC_HEAD +
  "A body match lists up to 3 sections, those containing the most keywords first and then in document order, each with an excerpt near the first hit; pass a `sectionId` to read_note_section. " +
  "`matches` can be empty for a body match; read the note's outline then. " +
  "Saved changes are usually searchable within seconds, but right after an upgrade older notes may match by title only for a while. " +
  "Attachments are not searched.";
export const SEARCH_NOTES_DESCRIPTION_NO_READ =
  DESC_HEAD +
  "A body match lists up to 3 sections, those containing the most keywords first and then in document order, each with an excerpt near the first hit; `matches` can be empty for a body match. " +
  "Attachments are not searched.";

export const SEARCH_TERMS_INVALID_MESSAGE = `Give 1 to ${SEARCH_TERMS_MAX} keywords: separate them with spaces, or put a phrase in double quotes.`;

export function searchNotesDescription(canRead: boolean): string {
  return canRead ? SEARCH_NOTES_DESCRIPTION_READ : SEARCH_NOTES_DESCRIPTION_NO_READ;
}

export const SEARCH_RATE_LIMITED_MESSAGE = "Too many searches right now. Wait a moment before searching again.";

export const searchNotesInput = {
  // The first two input-safety layers are in the schema (`noNul`); the third is drizzle's parameterization. MCP doesn't trim.
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY)
    .refine(noNul)
    .describe("Keywords to look for in note titles and body text, separated by spaces; a phrase in double quotes is one keyword. Matched literally — `%` and `_` are not wildcards."),
  terms: z
    .enum(SEARCH_TERMS_MODES)
    .optional()
    .describe("`all` (default): a note must contain every keyword. `any`: at least one, notes with more keywords first."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many notes to return, 1 to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`),
};

export function searchNotesOutputFor(canRead: boolean) {
  const match = z.object({
    sectionId: z.string().describe(canRead ? "Pass this to read_note_section." : "The section's id."),
    heading: z.string().max(MCP_TEXT_MAX).describe("The section's heading, cut at 200 characters as written in JSON. Empty for `_top`."),
    headingTruncated: z.literal(true).optional().describe("Present only when `heading` was cut."),
    snippet: z.string().max(MCP_SNIPPET_MAX).describe("An excerpt of the section's text near the first hit, cut at 160 characters as written in JSON."),
    matchedTerms: z.array(z.string()).optional().describe("Only with several keywords: the ones this section contains."),
  });
  const hit = noteSummarySchema.extend({
    matchedOn: z.enum(["title", "body", "both"]).describe("Whether your text was found in the title, the body, or both."),
    matches: z
      .array(match)
      .max(SEARCH_MATCHES_PER_NOTE)
      .describe("Up to 3 sections that contain your text, those with the most keywords first, then in document order. Empty when `matchedOn` is `title`, and can be empty for a body match."),
    matchedTerms: z.array(z.string()).optional().describe("Only with several keywords: the ones this note contains, in its title or body."),
  });
  return {
    notes: z.array(hit).describe("The matching notes, best match first."),
    truncated: z
      .boolean()
      .describe("True when more notes matched than were returned. Narrow the query — there is no next page."),
    matchesTruncated: z
      .literal(true)
      .optional()
      .describe("Present when some matches were left out to keep this reply small. Ask for fewer notes with `limit`."),
  };
}

export interface SearchMatchForModel {
  sectionId: string;
  heading: string;
  headingTruncated?: true;
  snippet: string;
  matchedTerms?: string[];
}

type MatchedOn = "title" | "body" | "both";
type SearchHitForModel = NoteSummaryForModel & { matchedOn: MatchedOn; matches: SearchMatchForModel[]; matchedTerms?: string[] };

export function assembleSearchPayload(
  notes: SearchHitForModel[],
  candidates: SearchMatchForModel[][],
  truncated: boolean,
  budget: number = MCP_SEARCH_WIRE_BUDGET,
): { notes: SearchHitForModel[]; truncated: boolean; matchesTruncated?: true } {
  let total = wireCost({ notes, truncated }) + MATCHES_TRUNCATED_RESERVE;
  let cut = false;
  outer: for (let i = 0; i < notes.length; i += 1) {
    for (const m of candidates[i] ?? []) {
      const c = wireCost(m) + 2; // Two copies of the comma; an upper bound
      if (total + c > budget) {
        cut = true;
        break outer;
      }
      total += c;
      notes[i]!.matches.push(m);
    }
  }
  return cut ? { notes, truncated, matchesTruncated: true as const } : { notes, truncated };
}

function matchedOnOf(row: NoteSearchRow): MatchedOn {
  if (row.titleHit && row.bodyHit) return "both";
  return row.titleHit ? "title" : "body";
}

function toMatch(m: SearchMatchRow, terms: readonly string[]): SearchMatchForModel {
  const heading = truncateText(m.heading);
  const snippet = buildSnippet(snippetWindowOf(m, terms), MCP_SNIPPET_MAX, escapedLength);
  const matchedTerms = matchedTermsOf(m.ps, terms);
  return {
    sectionId: m.section_id, heading: heading.text, ...(heading.truncated ? { headingTruncated: true as const } : {}), snippet,
    ...(matchedTerms !== undefined ? { matchedTerms } : {}),
  };
}

export interface SearchNotesArgs {
  query: string;
  terms?: "all" | "any";
  limit?: number;
}

export async function searchNotes(args: SearchNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const terms = parseSearchTerms(args.query);
  if (terms === null || terms.length === 0) return toolError("invalid_body", SEARCH_TERMS_INVALID_MESSAGE);
  if (!ctx.limiters.search.consume(ctx.userId)) return toolError("too_many_requests", SEARCH_RATE_LIMITED_MESSAGE);
  const limit = args.limit ?? DEFAULT_LIMIT;
  const { rows, matches } = await searchNotesForUser(ctx.db, { userId: ctx.userId, terms, mode: args.terms ?? "all", limit });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const byNote = groupMatchesByNote(matches);
  const summaries = await noteSummariesForModel(ctx.db, page);
  const notes: SearchHitForModel[] = page.map((row, i) => {
    const matchedTerms = matchedTermsOf(row.termHits, terms);
    return { ...summaries[i]!, matchedOn: matchedOnOf(row), matches: [], ...(matchedTerms !== undefined ? { matchedTerms } : {}) };
  });
  const candidates = page.map(row => (row.bodyHit ? (byNote.get(row.id) ?? []).map(m => toMatch(m, terms)) : []));
  return toolResult(assembleSearchPayload(notes, candidates, truncated));
}
