// Each note runs inside `writes.runExclusive` (the shared write queue). The pre-conversion version is saved via `versions.cutIfDirty` directly, never `writes.saveVersion` (it would wait on the queue we're in). If the signal is already aborted nothing writes a marker (the note stays pending). `note_links` is only added to, always before a note is marked done. The merge carries no userId and expects the whole-note fingerprint. Logs never record href, title or text.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  MAX_LINK_TARGETS,
  YDOC_FRAGMENT,
  convertSiteLinksInContent,
  extractLinkTargets,
  parseSiteNoteHref,
  type SiteLinkTarget,
  type SiteNoteHref,
} from "@knotebook/shared";
import type { VersionService } from "../collab/versions.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { noteLinkConversion, noteLinks, notes } from "../db/schema.js";
import { visibleTitlesByIds } from "./editing/candidates.js";
import { FingerprintMismatch, forkAndCheck, mergeDiff, type ApplyDeps } from "./editing/apply.js";
import { QueueBusyError } from "./editing/queue.js";
import { EditorSession, NoteGoneError, type LinkConvertCtx } from "./editing/session.js";
import type { NoteWriteService } from "./editing/write-service.js";
import { normalizeLinkTargets } from "./links.js";
import { createSiteLinkResolver, type SiteLinkScope } from "./site-link-resolver.js";

export const LINK_CONVERSION_BATCH = 50;
export const LINK_CONVERSION_QUEUE_WAIT_MS = 1_000;
export const LINK_CONVERSION_MAX_ATTEMPTS = 3;
export const LINK_CONVERSION_START_DELAY_MS = 30_000;
export const LINK_CONVERSION_VERSION_NAME = "連結轉換前";

export interface LinkConversionLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface LinkConversionDeps {
  db: Db;
  writes: Pick<NoteWriteService, "runExclusive">;
  versions: Pick<VersionService, "docFor" | "cutIfDirty">;
  log: LinkConversionLog;
  siteOrigin: string;
}

export interface LinkConversionSummary {
  scanned: number;
  notesConverted: number;
  linksConverted: number;
  unresolved: number;
  retry: number;
  failed: number;
}

type NoteOutcome =
  | { kind: "done"; converted: number; unresolved: number }
  | { kind: "retry" }
  | { kind: "deleted" }
  | { kind: "aborted" };

export function scanSiteLinkHrefs(doc: Y.Doc, siteOrigin: string): Map<string, SiteNoteHref> {
  const out = new Map<string, SiteNoteHref>();
  for (const node of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(n => n instanceof Y.XmlText)) {
    if (!(node instanceof Y.XmlText)) continue;
    for (const op of node.toDelta() as Array<{ attributes?: { link?: { href?: unknown } } }>) {
      const href = op.attributes?.link?.href;
      if (typeof href !== "string" || out.has(href)) continue;
      const parsed = parseSiteNoteHref(href, siteOrigin);
      if (parsed) out.set(href, parsed);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote Block generic triple; repo convention
type AnyBlock = { id: string; content?: unknown; children?: AnyBlock[] } & Record<string, any>;

/** Only blocks whose own content has a resolvable link are updated, keeping other blocks byte-identical and the normalization range minimal. */
export async function prepareLinkConversion(
  deps: ApplyDeps,
  fork: Y.Doc,
  sv: Uint8Array,
  resolved: ReadonlyMap<string, SiteLinkTarget>,
  siteOrigin: string,
): Promise<{ diff: Uint8Array; converted: number }> {
  const s = await EditorSession.open(deps.editing, fork);
  try {
    let converted = 0;
    const resolve = (href: string) => resolved.get(href) ?? null;
    const visit = (blocks: AnyBlock[]): void => {
      for (const block of blocks) {
        const stats = { converted: 0, unresolved: 0 };
        const next = convertSiteLinksInContent(block.content, resolve, siteOrigin, stats);
        if (stats.converted > 0 && next !== block.content) {
          s.editor.updateBlock(block.id, { content: next as never });
          converted += stats.converted;
        }
        if (Array.isArray(block.children) && block.children.length > 0) visit(block.children);
      }
    };
    visit(s.editor.document as AnyBlock[]);
    return { diff: s.diffSince(sv), converted };
  } finally {
    s.close();
  }
}

async function backfillNoteLinks(db: Db, noteId: string, scope: SiteLinkScope, doc: Y.Doc): Promise<void> {
  const norm = normalizeLinkTargets(noteId, extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS));
  if (!norm.ok || norm.targets.length === 0) return;
  // #181: the group branch deliberately doesn't exclude trashed targets, so backlinks survive a restore.
  const allowed =
    scope.kind === "user"
      ? (await visibleTitlesByIds(db, scope.userId, norm.targets)).map(t => t.id)
      : (await db.select({ id: notes.id }).from(notes).where(and(inArray(notes.id, norm.targets), eq(notes.groupId, scope.groupId)))).map(r => r.id);
  if (allowed.length === 0) return;
  try {
    await db.insert(noteLinks).values(allowed.map(targetNoteId => ({ sourceNoteId: noteId, targetNoteId }))).onConflictDoNothing();
  } catch (err) {
    // Target just deleted: the next sync converges.
    if (!isForeignKeyViolation(err)) throw err;
  }
}

async function cutBeforeConversion(deps: LinkConversionDeps, noteId: string): Promise<"ok" | "retry" | "deleted"> {
  for (let i = 0; i < 2; i += 1) {
    const { doc, transient } = await deps.versions.docFor(noteId);
    const r = await deps.versions.cutIfDirty(noteId, doc, { kind: "manual", name: LINK_CONVERSION_VERSION_NAME, keepExistingName: true, extraEditors: [], transient });
    if (r === null) continue;
    if ("skipped" in r) return r.skipped === "note-deleted" ? "deleted" : "retry";
    return "ok";
  }
  return "retry";
}

async function processNote(deps: LinkConversionDeps, applyDeps: ApplyDeps, noteId: string, signal: AbortSignal, stage: { name: string }): Promise<NoteOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  stage.name = "scope";
  // A trashed note counts as deleted (consistent with `scanDue`); its row stays as is.
  const [meta] = await deps.db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt))).limit(1);
  if (!meta) return { kind: "deleted" };
  const scope: SiteLinkScope = meta.groupId !== null ? { kind: "group", groupId: meta.groupId } : { kind: "user", userId: meta.ownerId! };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    stage.name = "fork";
    const f = await forkAndCheck(applyDeps, noteId);
    if (f.isEmptyDoc) return { kind: "done", converted: 0, unresolved: 0 };
    stage.name = "scan";
    const hrefs = scanSiteLinkHrefs(f.fork, deps.siteOrigin);
    if (hrefs.size === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved: 0 };
    }
    stage.name = "resolve";
    const resolver = createSiteLinkResolver(deps.db, scope);
    const resolved = new Map<string, SiteLinkTarget>();
    let unresolved = 0;
    for (const [href, parsed] of hrefs) {
      const target = await resolver.resolve(href, parsed);
      if (target) resolved.set(href, target);
      else unresolved += 1;
    }
    if (signal.aborted) return { kind: "aborted" };
    if (resolved.size === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved };
    }
    stage.name = "version";
    if (signal.aborted) return { kind: "aborted" };
    const cut = await cutBeforeConversion(deps, noteId);
    if (cut === "deleted") return { kind: "deleted" };
    if (cut === "retry") {
      deps.log.warn({ noteId, stage: stage.name, err: "version-skipped" }, "站內連結轉換：單篇失敗");
      return { kind: "retry" };
    }
    stage.name = "prepare";
    const prepared = await prepareLinkConversion(applyDeps, f.fork, f.sv, resolved, deps.siteOrigin);
    if (signal.aborted) return { kind: "aborted" };
    if (prepared.converted === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved };
    }
    stage.name = "merge";
    if (applyDeps.testHooks?.beforeMerge) await applyDeps.testHooks.beforeMerge();
    const ctx: LinkConvertCtx = { source: "link-convert", applied: false };
    try {
      await mergeDiff(applyDeps, noteId, ctx, { targetIds: null, expectFingerprint: f.whole, anchorId: null, diff: prepared.diff, afterIds: [] });
    } catch (err) {
      if (err instanceof NoteGoneError) return { kind: "deleted" };
      if (err instanceof FingerprintMismatch) continue;
      throw err;
    }
    stage.name = "links";
    await backfillNoteLinks(deps.db, noteId, scope, f.fork);
    return { kind: "done", converted: prepared.converted, unresolved };
  }
  deps.log.warn({ noteId, stage: "merge", err: "fingerprint-mismatch" }, "站內連結轉換：單篇失敗");
  return { kind: "retry" };
}

async function record(deps: LinkConversionDeps, row: { noteId: string; attempts: number }, outcome: NoteOutcome, summary: LinkConversionSummary): Promise<void> {
  const where = eq(noteLinkConversion.noteId, row.noteId);
  if (outcome.kind === "done") {
    await deps.db.update(noteLinkConversion).set({ status: "done", converted: outcome.converted, unresolved: outcome.unresolved, updatedAt: sql`now()` }).where(where);
    if (outcome.converted > 0) summary.notesConverted += 1;
    summary.linksConverted += outcome.converted;
    summary.unresolved += outcome.unresolved;
    return;
  }
  if (outcome.kind === "retry") {
    const failed = row.attempts + 1 >= LINK_CONVERSION_MAX_ATTEMPTS;
    await deps.db
      .update(noteLinkConversion)
      .set({ status: failed ? "failed" : "retry", attempts: sql`${noteLinkConversion.attempts} + 1`, updatedAt: sql`now()` })
      .where(where);
    if (failed) {
      summary.failed += 1;
      deps.log.error({ noteId: row.noteId, attempts: row.attempts + 1 }, "站內連結轉換：第 3 次失敗，標 failed、不再自動重試（手動重跑＝把該列改回 pending）");
    } else summary.retry += 1;
  }
}

/** Only class name and code: drizzle's `DrizzleQueryError` message embeds params (link handles/slugs, or the whole Yjs update = note plaintext), and pg errors' `detail` can carry values. */
export function errorSummary(err: unknown): { name: string; code?: string } {
  const codeOf = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
  const name = err instanceof Error ? err.constructor.name || "Error" : typeof err;
  const code = codeOf(err) ?? codeOf((err as { cause?: unknown } | null)?.cause);
  return code === undefined ? { name } : { name, code };
}

type OneResult = "busy" | "aborted" | "recorded";

async function convertOne(deps: LinkConversionDeps, row: { noteId: string; attempts: number }, signal: AbortSignal, summary: LinkConversionSummary): Promise<OneResult> {
  const stage = { name: "queue" };
  let outcome: NoteOutcome;
  try {
    outcome = await deps.writes.runExclusive(deps.log, row.noteId, LINK_CONVERSION_QUEUE_WAIT_MS, applyDeps =>
      processNote(deps, applyDeps, row.noteId, signal, stage),
    );
  } catch (err) {
    if (signal.aborted) return "aborted";
    if (err instanceof QueueBusyError) return "busy";
    deps.log.warn({ noteId: row.noteId, stage: stage.name, err: errorSummary(err) }, "站內連結轉換：單篇失敗");
    outcome = { kind: "retry" };
  }
  if (signal.aborted || outcome.kind === "aborted") return "aborted";
  summary.scanned += 1;
  await record(deps, row, outcome, summary);
  return "recorded";
}

export async function runLinkConversion(deps: LinkConversionDeps, opts: { signal: AbortSignal; batchSize?: number }): Promise<LinkConversionSummary> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? LINK_CONVERSION_BATCH;
  const summary: LinkConversionSummary = { scanned: 0, notesConverted: 0, linksConverted: 0, unresolved: 0, retry: 0, failed: 0 };
  deps.log.info({}, "站內連結轉換：開始");
  const busy: Array<{ noteId: string; attempts: number }> = [];
  let cursor: string | null = null;
  outer: while (!opts.signal.aborted) {
    const rows: Array<{ noteId: string; attempts: number }> = await deps.db
      .select({ noteId: noteLinkConversion.noteId, attempts: noteLinkConversion.attempts })
      .from(noteLinkConversion)
      .where(and(inArray(noteLinkConversion.status, ["pending", "retry"]), lt(noteLinkConversion.attempts, LINK_CONVERSION_MAX_ATTEMPTS), cursor === null ? undefined : gt(noteLinkConversion.noteId, cursor)))
      .orderBy(asc(noteLinkConversion.noteId))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (opts.signal.aborted) break outer;
      await yieldToLoop();
      const r = await convertOne(deps, row, opts.signal, summary);
      if (r === "aborted") break outer;
      if (r === "busy") busy.push(row);
    }
    cursor = rows[rows.length - 1]!.noteId;
  }
  for (const row of busy) {
    if (opts.signal.aborted) break;
    if ((await convertOne(deps, row, opts.signal, summary)) === "aborted") break;
  }
  deps.log.info({ ...summary, ms: Date.now() - started }, "站內連結轉換：結束");
  return summary;
}

export interface LinkConversion {
  start(): void;
  stop(): Promise<void>;
  readonly deps: LinkConversionDeps | null;
}

export const NOOP_LINK_CONVERSION: LinkConversion = { start() {}, stop: () => Promise.resolve(), deps: null };

/** `start()` runs once (later calls no-op) after `startDelayMs`; `stop()` aborts and resolves when the in-flight note finishes or is abandoned. `stop()` never rejects: `index.ts` races it against a 2 s timer, and a rejection would skip `collab.destroy()` and lose pending edits. */
export function createLinkConversion(deps: LinkConversionDeps, opts: { startDelayMs?: number } = {}): LinkConversion {
  const controller = new AbortController();
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  return {
    deps,
    start() {
      if (started) return;
      started = true;
      timer = setTimeout(() => {
        timer = undefined;
        running = runLinkConversion(deps, { signal: controller.signal }).then(
          () => undefined,
          err => deps.log.error({ err: errorSummary(err) }, "站內連結轉換中止"),
        );
      }, opts.startDelayMs ?? LINK_CONVERSION_START_DELAY_MS);
      timer.unref?.();
    },
    stop() {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      return (running ?? Promise.resolve()).then(() => undefined, () => undefined);
    },
  };
}
