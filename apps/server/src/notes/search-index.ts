// An FK violation counts as `"gone"` defensively: the transaction already holds notes KEY SHARE, so current paths can't reach it (no test guards it). `bumpSearchIndexVersion` locks only the state row (a deleter holds notes then waits on the state row: no cycle) and advances only when hash and extractor version match.
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteSearchState, noteStates } from "../db/schema.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { SEARCH_EXTRACTOR_VERSION, extractSearchSections, type SearchExtract } from "./search-text.js";
import { SearchIndexSkip, replaceNoteSearchIndexInTx, type SearchIndexHooks, type SearchIndexTxResult } from "./tx/search-index.js";

export type SearchIndexOutcome = "written" | "unchanged" | "gone" | "stale";

export interface SearchIndexLogger {
  warn(obj: object, msg: string): void;
}

export function extractForIndex(doc: Y.Doc): SearchExtract {
  return extractSearchSections(doc.getXmlFragment(YDOC_FRAGMENT));
}

export async function writeSearchIndex(
  db: Db,
  noteId: string,
  sourceVersion: number,
  extract: SearchExtract,
  opts: { log?: SearchIndexLogger; hooks?: SearchIndexHooks } = {},
): Promise<SearchIndexOutcome> {
  const input = { noteId, sourceVersion, extract };
  const hooks = opts.hooks;
  let result: SearchIndexTxResult;
  try {
    result = await db.transaction(tx => replaceNoteSearchIndexInTx(tx, input, hooks));
  } catch (err) {
    if (err instanceof SearchIndexSkip) return err.reason;
    if (isForeignKeyViolation(err)) return "gone";
    throw err;
  }
  if (result.regressed) {
    opts.log?.warn({ noteId, ...result.regressed }, "note_states.version 小於索引的 source_version（應用以外的回寫？）——照寫目前落盤的內容");
  }
  return result.outcome;
}

export async function bumpSearchIndexVersion(db: Db, noteId: string, sourceVersion: number, contentHash: string): Promise<number> {
  const updated = await db
    .update(noteSearchState)
    .set({ sourceVersion })
    .where(
      and(
        eq(noteSearchState.noteId, noteId),
        eq(noteSearchState.contentHash, contentHash),
        eq(noteSearchState.extractorVersion, SEARCH_EXTRACTOR_VERSION),
        lt(noteSearchState.sourceVersion, sourceVersion),
      ),
    )
    .returning({ noteId: noteSearchState.noteId });
  return updated.length;
}

const BACKFILL_BATCH = 20;
const BACKFILL_PROGRESS_EVERY = 500;

export interface BackfillLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface BackfillOptions {
  signal?: AbortSignal;
  batchSize?: number;
  afterEachForTest?: (noteId: string) => void | Promise<void>;
}

export interface BackfillResult {
  candidates: number;
  done: number;
  skipped: number;
  failed: number;
  aborted: boolean;
  ms: number;
}

function backfillCandidate() {
  return or(
    isNull(noteSearchState.noteId),
    ne(noteSearchState.extractorVersion, SEARCH_EXTRACTOR_VERSION),
    ne(noteSearchState.sourceVersion, noteStates.version),
  );
}

/** Converges to the latest persisted version under any interleaving with live persists (lock first, then read the version). */
export async function backfillSearchIndex(db: Db, log: BackfillLogger, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? BACKFILL_BATCH;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(noteStates)
    .leftJoin(noteSearchState, eq(noteSearchState.noteId, noteStates.noteId))
    .where(backfillCandidate());
  const candidates = count?.n ?? 0;
  log.info({ candidates }, "全文索引回填開始");
  let after: string | null = null;
  let processed = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;
  outer: for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const page = await db
      .select({ noteId: noteStates.noteId })
      .from(noteStates)
      .leftJoin(noteSearchState, eq(noteSearchState.noteId, noteStates.noteId))
      .where(and(after === null ? undefined : gt(noteStates.noteId, after), backfillCandidate()))
      .orderBy(asc(noteStates.noteId))
      .limit(batchSize);
    if (page.length === 0) break;
    for (const { noteId } of page) {
      if (opts.signal?.aborted) {
        aborted = true;
        break outer;
      }
      after = noteId;
      processed += 1;
      try {
        const [row] = await db.select({ ydoc: noteStates.ydoc, version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
        if (!row) {
          skipped += 1;
        } else {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, row.ydoc);
            // Shutdown may arrive during the await above; check again so we don't write while the pool is closing and log a misleading failed:1.
            if (opts.signal?.aborted) {
              aborted = true;
              break outer;
            }
            const outcome = await writeSearchIndex(db, noteId, row.version, extractForIndex(doc), { log });
            if (outcome === "written" || outcome === "unchanged") done += 1;
            else skipped += 1;
          } finally {
            doc.destroy();
          }
        }
      } catch (err) {
        failed += 1;
        log.warn({ err, noteId }, "全文索引回填：單篇失敗（略過，繼續）");
      }
      await opts.afterEachForTest?.(noteId);
      if (processed % BACKFILL_PROGRESS_EVERY === 0) log.info({ processed, done, skipped, failed }, "全文索引回填進度");
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const result: BackfillResult = { candidates, done, skipped, failed, aborted, ms: Date.now() - started };
  log.info(result, aborted ? "全文索引回填中止（下次啟動接續）" : "全文索引回填完成");
  return result;
}
