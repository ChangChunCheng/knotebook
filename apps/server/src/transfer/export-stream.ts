/**
 * Directories first, then notes in full-path code-unit order, the manifest last; batches of
 * 50. Each batch: checkpoint (token row still there + user gate) → re-query the batch with the
 * same visibility and scope (gone or out of scope → `skipped: gone`) → build and write entries
 * (with backpressure), yield → one INSERT of bases. A failed checkpoint or base insert aborts.
 * Abort = `writer.abort()` + `reply.raw.destroy()` with no tar/gzip/chunked trailer (curl
 * exits 18). Client disconnect is detected on `reply.raw`'s close, not `request.raw` (see
 * `routes/ai.ts`). The outcome is fixed at the moment of decision: abort sets `aborted` before
 * destroy, `done` is set when `finish()` resolves, and the close handler sets `client_closed`
 * only if no outcome is set and `!writableFinished`, otherwise it only aborts (idempotent).
 * finally: release the slot → `onExportEnd` → prune bases only on `done` → one info log line
 * (counts and ids only, never titles, paths, tokens or content).
 */
import { setImmediate as setImmediateP } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { UserGate } from "../auth/session.js";
import type { BulkRange } from "../auth/transfer-token.js";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { insertBases, pruneBases, type TransferBaseInsert } from "./bases.js";
import { buildNoteFile, type NoteFile, type NoteFileDeps } from "./note-file.js";
import type { Layout, LayoutFolder, LayoutGroup } from "./paths.js";
import { inRangeIds, visibleNotes, type RangeNoteRow } from "./range.js";
import { TarAbortError, TarGzWriter } from "./tar.js";

export const TRANSFER_EXPORT_MAX_NOTES = 3000;
export const EXPORT_BATCH = 50;
export const EXPORT_BUSY_RETRY_AFTER_S = 30;

export type ExportOutcome = "done" | "aborted" | "client_closed";

export interface ExportTestHooks {
  beforeBatch?(index: number): Promise<void>;
  afterNote?(noteId: string): Promise<void>;
  onExportEnd?(outcome: ExportOutcome): void;
  forceUnmergeable?(noteId: string): boolean;
  /** The message deliberately carries content, to catch a failed branch that logs the raw err. */
  forceFailNote?(noteId: string): string | undefined;
  onClientClose?(): void;
  beforeStream?(): void;
}

export interface StreamExportParams {
  db: Db;
  gate: UserGate;
  log: FastifyBaseLogger;
  fileDeps: NoteFileDeps;
  reply: FastifyReply;
  userId: string;
  tokenId: string;
  parentTokenId: string;
  range: BulkRange;
  tree: { folders: LayoutFolder[]; groups: LayoutGroup[] };
  layout: Layout;
  site: string;
  exportedAt: Date;
  release: () => void;
  hooks?: ExportTestHooks;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export function exportFileName(at: Date): string {
  const d = `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
  const t = `${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}`;
  return `knotebook-${d}-${t}.tar.gz`;
}

export async function streamExport(p: StreamExportParams): Promise<void> {
  const started = Date.now();
  const raw = p.reply.raw;
  let outcome = null as ExportOutcome | null;
  p.hooks?.beforeStream?.();
  raw.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${exportFileName(p.exportedAt)}"`,
    // hijack bypasses onSend, so the site-wide nosniff must be set here.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const writer = new TarGzWriter(raw, { mtime: p.exportedAt });
  const onClose = () => {
    p.hooks?.onClientClose?.();
    if (outcome === null && !raw.writableFinished) outcome = "client_closed";
    writer.abort(new Error("client closed"));
  };
  raw.on("close", onClose);
  raw.on("error", () => {});
  if (raw.destroyed) onClose();
  const abortStream = () => {
    if (outcome === null) outcome = "aborted";
    writer.abort(new Error("export aborted"));
    raw.destroy();
  };

  const order = [...p.layout.files.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const manifestNotes: Array<{ path: string; id: string; role: string; mergeable?: false; tooLargeToSend?: true }> = [];
  const skipped: Array<{ id: string; reason: "gone" | "failed" | "busy" }> = [];
  let notMergeable = 0;
  let written = 0;
  try {
    for (const d of p.layout.dirs) await writer.addDir(d.path);
    for (let b = 0; b * EXPORT_BATCH < order.length; b++) {
      if (outcome !== null) break;
      await p.hooks?.beforeBatch?.(b);
      if (outcome !== null) break;
      // The token row still exists (revoking it or its parent cascades) and the user gate passes; expiry is deliberately not checked: it doesn't abort a stream already started.
      const [tok] = await p.db.select({ id: transferTokens.id }).from(transferTokens).where(eq(transferTokens.id, p.tokenId)).limit(1);
      const g = tok === undefined ? null : await p.gate.checkUser(p.userId);
      if (g === null || g.status !== "ok" || g.user.mustChangePassword) {
        abortStream();
        break;
      }
      const batch = order.slice(b * EXPORT_BATCH, (b + 1) * EXPORT_BATCH);
      const rows = await visibleNotes(p.db, p.userId, { ids: batch.map(([id]) => id) });
      const still = inRangeIds(rows, p.tree, p.range);
      const byId = new Map<string, RangeNoteRow>(rows.map(r => [r.id, r]));
      const bases: TransferBaseInsert[] = [];
      for (const [id, path] of batch) {
        if (outcome !== null) break;
        const row = byId.get(id);
        if (row === undefined || !still.has(id)) {
          skipped.push({ id, reason: "gone" });
          continue;
        }
        let nf: NoteFile;
        try {
          const failWith = p.hooks?.forceFailNote?.(id);
          if (failWith !== undefined) throw new Error(`${row.title} ${failWith}`);
          nf = await buildNoteFile(p.fileDeps, p.userId, row, { forceUnmergeable: p.hooks?.forceUnmergeable?.(id) === true });
        } catch (err) {
          // Log counts only: the error text may carry a title or content. A busy worker is `busy`, distinct from `failed`, so the caller knows to retry that note later.
          skipped.push({ id, reason: err instanceof ParserBusyError ? "busy" : "failed" });
          continue;
        }
        await writer.addFile(path, nf.file);
        written++;
        bases.push(nf.base);
        if (!nf.mergeable) notMergeable++;
        manifestNotes.push({
          path, id, role: row.role,
          ...(nf.mergeable ? {} : { mergeable: false as const }),
          ...(nf.file.length > TRANSFER_WRITE_BODY_LIMIT ? { tooLargeToSend: true as const } : {}),
        });
        await p.hooks?.afterNote?.(id);
        await setImmediateP();
      }
      if (outcome !== null) break;
      try {
        await insertBases(p.db, p.log, bases);
      } catch {
        abortStream();
        break;
      }
    }
    if (outcome === null) {
      const manifest = {
        knotebook: 1,
        exportedAt: p.exportedAt.toISOString(),
        site: p.site,
        range: p.range,
        folders: p.layout.dirs,
        notes: manifestNotes,
        skipped,
      };
      await writer.addFile(".knotebook/manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
      await writer.finish();
      outcome = "done";
    }
  } catch (err) {
    if (!(err instanceof TarAbortError)) {
      p.log.warn({ ...pgErrorSummary(err) }, "整包匯出中止");
      abortStream();
    }
  } finally {
    const final: ExportOutcome = outcome ?? "aborted";
    if (outcome === null) abortStream();
    p.release();
    p.hooks?.onExportEnd?.(final);
    if (final === "done") pruneBases(p.db, p.log, p.userId, manifestNotes.map(n => n.id));
    p.log.info(
      { userId: p.userId, tokenId: p.parentTokenId, range: p.range, notes: written, skipped: skipped.length, notMergeable, bytes: writer.bytesOut, ms: Date.now() - started, outcome: final },
      "bulk transfer export",
    );
  }
}
