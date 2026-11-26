// q is trimmed (MCP isn't). match=body exists because on common words title hits (rank 0–2) push body-only hits (rank 3) off the page, and the web computes title matches itself.
// The cursor carries sort values and a query fingerprint only, no authorization; notes edited between pages can be missed or duplicated, so the web dedupes by id.
// Visibility comes only from visibleNoteBranches. No transaction here: searchNotesForUser runs the same REPEATABLE READ READ ONLY transaction as MCP search_notes.
// Validation failures (including the cursor) don't consume the search limiter (shared with MCP search_notes).
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  parseSearchTerms, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, SEARCH_TERMS_MAX, SEARCH_TERMS_MODES,
  type NoteSearchHitDto, type NoteSearchMatchDto, type NoteSearchResultDto, type SearchTermsMode,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { decodeKeysetCursor, encodeKeysetCursor, parseCursorTimestamp } from "../mcp/keyset-cursor.js";
import { truncateCodeUnits } from "../mcp/limits.js";
import { accessFromListRow } from "../notes/list-query.js";
import { toNoteDto } from "../notes/note-dto.js";
import { noNul } from "../notes/schemas.js";
import { groupMatchesByNote, matchedTermsOf, searchNotesForUser, snippetWindowOf } from "../notes/search-query.js";
import { maxSearchRank, type NoteSearchRow, type SearchMatchRow, type SearchPageKey } from "../notes/search-sql.js";
import { buildSnippet } from "../notes/search-snippet.js";
import { UUID_RE } from "../notes/service.js";
import { INVALID_SEARCH_TAGS_MESSAGE, resolveSearchTagFilter } from "../tags/search-filter.js";

export const REST_SNIPPET_MAX = 160;
export const REST_HEADING_MAX = 200;

const INVALID_QUERY = "The search text must be 1 to 200 characters and can't contain characters that can't be processed.";
const INVALID_TERMS = `The search text must have 1 to ${SEARCH_TERMS_MAX} keywords, separated by spaces or quoted as phrases.`;
const INVALID_LIMIT = `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}.`;
const INVALID_CURSOR = "The cursor is invalid. Search again from the first page.";
const RATE_LIMITED = "Too many searches. Wait a moment and try again.";

const searchQuerySchema = z
  .object({
    q: z
      .string()
      .transform(s => s.trim())
      .pipe(z.string().min(1, INVALID_QUERY).max(SEARCH_QUERY_MAX, INVALID_QUERY).refine(noNul, INVALID_QUERY)),
    limit: z
      .string()
      .regex(/^\d+$/, INVALID_LIMIT)
      .transform(Number)
      .pipe(z.number().int().min(1, INVALID_LIMIT).max(SEARCH_LIMIT_MAX, INVALID_LIMIT))
      .optional(),
    match: z.enum(["all", "body"]).optional(),
    keywords: z.enum(SEARCH_TERMS_MODES).optional(),
    cursor: z.string().optional(),
    tags: z.string().optional(),
  })
  .strict();

type Match = "all" | "body";

// `multiTerm` and `keywords=any` are added only when active: single-keyword cursors issued before #399 keep verifying,
// while pre-#399 cursors for queries with spaces (now split into keywords with different ranks) get 400.
function fingerprintOf(match: Match, q: string, tagIds: readonly string[], mode: SearchTermsMode, multiTerm: boolean): string {
  let input = tagIds.length === 0 ? `${match}\0${q}` : `${match}\0${q}\0${[...tagIds].sort().join(",")}`;
  if (multiTerm) input += "\0multi";
  if (mode === "any") input += "\0any";
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

const RANK_RE = /^(0|[1-9][0-9]?)$/;
const UPDATED_AT_KEY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

function encodeSearchCursor(fp: string, key: SearchPageKey): string {
  return encodeKeysetCursor("s", [fp, String(key.rank), key.updatedAtKey, key.id]);
}

/** `maxRank`: from `maxSearchRank` for this query, so a cursor can't carry a rank its query can't produce. */
export function decodeSearchCursor(raw: string, fp: string, maxRank: number): SearchPageKey | null {
  const parts = decodeKeysetCursor(raw, "s", 4);
  if (parts === null) return null;
  const [cfp, rank, updatedAtKey, id] = parts as [string, string, string, string];
  if (cfp !== fp || !RANK_RE.test(rank) || Number(rank) > maxRank) return null;
  const m = UPDATED_AT_KEY_RE.exec(updatedAtKey);
  if (m === null || parseCursorTimestamp(`${m[1]}Z`) === null) return null;
  if (!UUID_RE.test(id)) return null;
  return { rank: Number(rank), updatedAtKey, id };
}

function matchedOnOf(row: NoteSearchRow): NoteSearchHitDto["matchedOn"] {
  if (row.titleHit && row.bodyHit) return "both";
  return row.titleHit ? "title" : "body";
}

function toMatchDto(m: SearchMatchRow, terms: readonly string[]): NoteSearchMatchDto {
  const matchedTerms = matchedTermsOf(m.ps, terms);
  return {
    sectionId: m.section_id,
    heading: truncateCodeUnits(m.heading, REST_HEADING_MAX).text,
    snippet: buildSnippet(snippetWindowOf(m, terms), REST_SNIPPET_MAX, cp => cp.length),
    ...(matchedTerms !== undefined ? { matchedTerms } : {}),
  };
}

export interface SearchRouteDeps {
  db: Db;
  limiters: { search: FixedWindowLimiter };
}

export function searchRoutes(deps: SearchRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/search", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { q } = parsed.data;
      const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;
      const match: Match = parsed.data.match ?? "all";
      const mode: SearchTermsMode = parsed.data.keywords ?? "all";
      const terms = parseSearchTerms(q);
      if (terms === null || terms.length === 0) return sendError(reply, 400, "invalid_body", INVALID_TERMS);
      const userId = request.user!.id;
      let tagIds: string[] = [];
      if (parsed.data.tags !== undefined) {
        const resolved = await resolveSearchTagFilter(deps.db, userId, parsed.data.tags);
        if (resolved === null) return sendError(reply, 400, "invalid_tags", INVALID_SEARCH_TAGS_MESSAGE);
        tagIds = resolved;
      }
      const fp = fingerprintOf(match, q, tagIds, mode, terms.length > 1);
      let after: SearchPageKey | null = null;
      if (parsed.data.cursor !== undefined) {
        after = decodeSearchCursor(parsed.data.cursor, fp, maxSearchRank(terms.length, mode));
        if (after === null) return sendError(reply, 400, "invalid_body", INVALID_CURSOR);
      }
      if (!deps.limiters.search.consume(userId)) return sendError(reply, 429, "too_many_requests", RATE_LIMITED);

      const { rows, matches } = await searchNotesForUser(deps.db, { userId, terms, mode, limit, bodyOnly: match === "body", tagIds, page: { after } });
      const page = rows.slice(0, limit);
      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = page.at(-1)!;
        if (last.updatedAtKey === undefined) throw new Error("search: updatedAtKey missing in page mode");
        nextCursor = encodeSearchCursor(fp, { rank: last.rank, updatedAtKey: last.updatedAtKey, id: last.id });
      }
      const byNote = groupMatchesByNote(matches);
      const hits = page.map((row): NoteSearchHitDto => {
        const matchedTerms = matchedTermsOf(row.termHits, terms);
        return {
          note: toNoteDto(row, accessFromListRow(row)),
          matchedOn: matchedOnOf(row),
          matches: row.bodyHit ? (byNote.get(row.id) ?? []).map(m => toMatchDto(m, terms)) : [],
          ...(matchedTerms !== undefined ? { matchedTerms } : {}),
        };
      });
      const body: NoteSearchResultDto = { hits, nextCursor };
      return reply.send(body);
    });
  };
}
