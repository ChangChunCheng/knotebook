// Auto versions come only from the pending scan: no idle timer, no cut on unload or around AI writes; apply never cuts.
// #272: in-memory state is per process (like NoteWriteQueue); pending cuts live in the DB, so the
// scanner resumes them after a restart.
import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  VERSION_AUTO_WAIT_MINUTES_DEFAULT, VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_KEEP_ALL_DAYS_DEFAULT, YDOC_FRAGMENT,
  type VersionCurrentDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groups, noteStates, noteVersions, notes, siteSettings, users } from "../db/schema.js";
import type { DirectCtx } from "../notes/editing/session.js";
import { UUID_RE } from "../notes/service.js";
import {
  PENDING_CLEARED, VersionCutAbort, cutVersionInTx, dedupeEditors, notBaseVersionSql, spaceKeyOf,
  type CutVersionInput, type NoteVersionRow, type VersionEditorJson,
} from "../notes/tx/versions.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../notes/version-fingerprint.js";
import { selectVersionsToDelete } from "./version-policy.js";

const DAY_MS = 86_400_000;
export const VERSION_SWEEP_BATCH = 100;
export const VERSION_SWEEP_INTERVAL_MS = 60 * 60_000;
export const VERSION_SWEEP_FIRST_DELAY_MS = 5 * 60_000;
export const VERSION_AUTO_SCAN_INTERVAL_MS = 30_000;
export const VERSION_AUTO_SCAN_BATCH = 100;
export const VERSION_AUTO_SCAN_BACKOFF_MS = 10 * 60_000;
/** Shared shutdown wait cap (app.ts onClose hooks, index.ts stopGrace()), so work stuck on a row lock or the DB can't eat docker stop's grace period. */
export const SCAN_STOP_GRACE_MS = 2_000;
const PRUNE_DELETE_CHUNK = 1000;
/** Retries for noteLoaded from onLoadDocument; only a concurrent forget (relocation) makes it fail. */
const NOTE_LOADED_MAX_ATTEMPTS = 5;

export interface VersionEditor {
  userId: string;
  agentLabel: string | null;
}
export type CutSkip = "uninitialized" | "applying" | "auto-disabled" | "fingerprint-failed" | "note-deleted";
export type CutResult = { row: NoteVersionRow; upgraded: boolean } | null | { skipped: CutSkip };
export interface CutOptions {
  kind: "auto" | "manual";
  name?: string | null;
  extraEditors?: VersionEditor[];
  transient?: Y.Doc;
  keepExistingName?: boolean;
}
export type CutOutcome =
  | { kind: "cut"; row: NoteVersionRow; upgraded: boolean }
  | { kind: "clean" }
  | { kind: "stale" }
  | { kind: "not-due" }
  | { kind: "skipped"; reason: CutSkip };
export interface VersionDocsHost {
  documents: { get(name: string): Y.Doc | undefined; has(name: string): boolean };
}
export interface VersionServiceDeps {
  db: Db;
  log: { warn(obj: object, msg: string): void };
  now?: () => Date;
  autoWaitMs?: number;
  testHooks?: {
    afterMetaRead?: (noteId: string) => Promise<void>;
    afterPruneRead?: (noteId: string, doomed: number[]) => Promise<void>;
    beforeCutDue?: (noteId: string) => Promise<void>;
  };
}
export interface VersionMeta {
  baseSeq: number | null;
  baseFingerprint: string | null;
  counter: number;
  spaceKey: string;
  autoEnabled: boolean;
  pendingAt: Date | null;
  /** Set only if the segment started without a base: fingerprint of the content before it. */
  pendingRefFingerprint: string | null;
}
export type VersionCurrentCore = Omit<VersionCurrentDto, "base">;
export interface VersionStateSnapshot {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  editors: VersionEditor[];
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
  lastStoredFingerprint: string | null;
}

interface NoteVersionState {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  /** Editors not yet in `version_pending_editors` (noteChanged does no DB work); merged on a changed store. */
  editors: Map<string, VersionEditor>;
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
  /** A store with this fingerprint is not a content change. */
  lastStoredFingerprint: string | null;
}

export interface VersionService {
  bind(host: VersionDocsHost): void;
  noteLoaded(noteId: string, doc: Y.Doc, opts?: { rerun?: boolean }): Promise<void>;
  noteChanged(noteId: string, who: VersionEditor): void;
  forget(noteId: string): void;
  relocated(noteIds: string[]): void;
  isDirty(noteId: string, doc: Y.Doc, transient?: Y.Doc): Promise<boolean>;
  cutIfDirty(noteId: string, doc: Y.Doc, opts: CutOptions): Promise<CutResult>;
  beginApply(noteId: string): void;
  // With `baseUpdate`: after the base write-back, before disconnect; keeps `applying`. Without: the outer
  // `finally` after disconnect clears it, so the scanner skips the note until pending is cleared (#272).
  endApply(noteId: string, baseUpdate?: { seq: number; fingerprint: string } | { reset: true }): void;
  docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }>;
  currentOf(noteId: string): Promise<VersionCurrentCore | null>;
  pruneNote(noteId: string, now?: Date): Promise<number>;
  sweep(now: Date): Promise<number>;
  debugState(noteId: string): VersionStateSnapshot | undefined;
  /** Awaited by server.ts under saveMutex after onStoreDocument; errors propagate. */
  noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void>;
  /** One round at a time; 0 after `stopScan`. Returns how many notes were selected, not cut. */
  scanDue(at?: Date): Promise<number>;
  /** Resolves when the in-flight round ends; it stops after its current note. */
  stopScan(): Promise<void>;
  overrideAutoWaitMs(ms: number | null): void;
}

/** null if the note doesn't exist, or if noteId isn't a UUID (documentName is client-chosen). */
export async function readVersionMeta(db: Db, noteId: string): Promise<VersionMeta | null> {
  if (!UUID_RE.test(noteId)) return null;
  const [r] = await db
    .select({
      baseSeq: notes.versionBaseSeq,
      baseFingerprint: notes.versionBaseFingerprint,
      counter: notes.versionCounter,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      pendingAt: notes.versionPendingAt,
      pendingRefFingerprint: notes.versionPendingRefFingerprint,
      userAuto: users.autoVersions,
      groupAuto: groups.autoVersions,
      siteAuto: siteSettings.autoVersionsEnabled,
    })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(eq(notes.id, noteId))
    .limit(1);
  if (!r) return null;
  const spaceAuto = r.ownerId !== null ? r.userAuto : r.groupAuto;
  return {
    baseSeq: r.baseSeq, baseFingerprint: r.baseFingerprint, counter: r.counter, spaceKey: spaceKeyOf(r), autoEnabled: r.siteAuto !== false && spaceAuto === true,
    pendingAt: r.pendingAt, pendingRefFingerprint: r.pendingRefFingerprint,
  };
}

function loadFingerprintOf(meta: Pick<VersionMeta, "baseFingerprint" | "pendingAt" | "pendingRefFingerprint">, actual: string | null): string | null {
  return meta.baseFingerprint === null && meta.pendingAt !== null ? meta.pendingRefFingerprint : actual;
}

export async function setVersionBase(db: Db, noteId: string, seq: number, fingerprint: string, versionId: string): Promise<boolean> {
  const updated = await db
    .update(notes)
    .set({ versionBaseSeq: seq, versionBaseFingerprint: fingerprint, versionBaseVersionId: versionId })
    .where(and(eq(notes.id, noteId), sql`exists (select 1 from note_versions v where v.note_id = ${noteId} and v.seq = ${seq} and v.id = ${versionId})`))
    .returning({ id: notes.id });
  return updated.length === 1;
}

export async function clearVersionBase(db: Db, noteId: string): Promise<void> {
  await db.update(notes).set({ versionBaseSeq: null, versionBaseFingerprint: null, versionBaseVersionId: null }).where(eq(notes.id, noteId));
}

// Single statement, no transaction: SET reads old values, so the CASE sees whether it was already
// pending. Editors always have both keys, so `@>` means equality (deduped in JS first). A spaceKey
// mismatch (a store landing after a move or transfer) matches 0 rows and counts as done.
export async function markPending(
  db: Db,
  input: { noteId: string; at: Date; add: VersionEditorJson[]; ref: string | null; spaceKey: string },
): Promise<number> {
  const sep = input.spaceKey.indexOf(":");
  const kind = sep < 0 ? "" : input.spaceKey.slice(0, sep);
  const id = sep < 0 ? "" : input.spaceKey.slice(sep + 1);
  if ((kind !== "u" && kind !== "g") || id === "") return 0;
  const space = kind === "u" ? sql`notes.owner_id = ${id}` : sql`notes.group_id = ${id}`;
  const add = JSON.stringify(dedupeEditors(input.add));
  const res = await db.execute(sql`
    update notes set
      version_pending_at = ${input.at},
      version_pending_ref_fingerprint = case when notes.version_pending_at is null and notes.version_base_seq is null
                                             then ${input.ref}::text else notes.version_pending_ref_fingerprint end,
      version_pending_editors = notes.version_pending_editors || coalesce((
        select jsonb_agg(n.e order by n.ord) from jsonb_array_elements(${add}::jsonb) with ordinality as n(e, ord)
        where not notes.version_pending_editors @> jsonb_build_array(n.e)), '[]'::jsonb)
    where notes.id = ${input.noteId} and ${space}`);
  return res.rowCount ?? 0;
}

export async function clearPending(db: Db, noteId: string): Promise<void> {
  await db.update(notes).set(PENDING_CLEARED).where(eq(notes.id, noteId));
}

/** Clears only a still-due segment, leaving a newer one pending. */
export async function clearPendingIfDue(db: Db, noteId: string, dueBy: Date): Promise<number> {
  const cleared = await db
    .update(notes)
    .set(PENDING_CLEARED)
    .where(and(eq(notes.id, noteId), lte(notes.versionPendingAt, dueBy)))
    .returning({ id: notes.id });
  return cleared.length;
}

const editorKey = (e: VersionEditor): string => JSON.stringify([e.userId, e.agentLabel]);

const toEditorsJson = (list: VersionEditor[]): VersionEditorJson[] =>
  dedupeEditors(list.map(e => ({ user_id: e.userId, agent_label: e.agentLabel })));

function safeFingerprint(doc: Y.Doc): string | null {
  try {
    return versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT));
  } catch {
    return null;
  }
}

function dirtyOf(s: Pick<NoteVersionState, "baseFingerprint" | "loadFingerprint">, fp: string): boolean {
  if (s.baseFingerprint !== null) return fp !== s.baseFingerprint;
  return (s.loadFingerprint === null || fp !== s.loadFingerprint) && fp !== VACUUM_VERSION_FINGERPRINT;
}

export function createVersionService(deps: VersionServiceDeps): VersionService {
  const db = deps.db;
  const now = deps.now ?? ((): Date => new Date());
  const states = new Map<string, NoteVersionState>();
  const applyingSet = new Set<string>();
  const warnedUninitialized = new Set<string>();
  let host: VersionDocsHost | null = null;
  let sweepCursor: string | null = null;
  let sweeping = false;
  // backoff: noteId → time (ms, on the scan's `at` clock) before which the note is skipped.
  let scanInflight: Promise<number> | null = null;
  let stopping = false;
  let overrideWaitMs: number | null = null;
  const backoff = new Map<string, number>();

  const blankState = (noteId: string): NoteVersionState => ({
    initialized: false, autoEnabled: false, spaceKey: "", editors: new Map(), loadFingerprint: null, baseFingerprint: null,
    applying: applyingSet.has(noteId), lastStoredFingerprint: null,
  });

  function entryFor(noteId: string): NoteVersionState {
    let e = states.get(noteId);
    if (!e) {
      e = blankState(noteId);
      states.set(noteId, e);
    }
    return e;
  }

  async function noteLoaded(noteId: string, doc: Y.Doc, opts: { rerun?: boolean } = {}): Promise<void> {
    for (let attempt = 0; attempt < NOTE_LOADED_MAX_ATTEMPTS; attempt += 1) {
      // The entry is the token: after the await, write only if Map.get(noteId) is still this entry.
      const e = entryFor(noteId);
      // Read before the await; also the lastStoredFingerprint baseline, so a store during a rerun counts as a change.
      const actual = safeFingerprint(doc);
      const meta = await readVersionMeta(db, noteId);
      if (states.get(noteId) !== e) {
        if (opts.rerun) return; // rerun: drop
        continue; // from onLoadDocument: retry
      }
      if (meta === null) {
        // Auto cuts become auto-disabled; manual ones get note-deleted inside the transaction.
        Object.assign(e, { initialized: true, autoEnabled: false, spaceKey: "", loadFingerprint: actual, baseFingerprint: null, lastStoredFingerprint: actual });
        return;
      }
      Object.assign(e, {
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, loadFingerprint: loadFingerprintOf(meta, actual),
        baseFingerprint: meta.baseFingerprint, applying: applyingSet.has(noteId), lastStoredFingerprint: actual,
      });
      return;
    }
    deps.log.warn({ noteId }, "版本狀態初始化重試次數用完（這個載入週期不切自動版本）");
  }

  function noteChanged(noteId: string, who: VersionEditor): void {
    const e = entryFor(noteId);
    const k = editorKey(who);
    if (!e.editors.has(k)) e.editors.set(k, who);
  }

  function forget(noteId: string): void {
    states.delete(noteId);
    warnedUninitialized.delete(noteId);
  }

  function relocated(noteIds: string[]): void {
    for (const id of noteIds) {
      forget(id);
      const doc = host?.documents.get(id);
      if (!doc) continue;
      entryFor(id); // so editors in the gap still have somewhere to go
      void noteLoaded(id, doc, { rerun: true }).catch(err => deps.log.warn({ err, noteId: id }, "搬移後重建版本狀態失敗"));
    }
  }

  type Resolved = { state: NoteVersionState; live: boolean } | "uninitialized" | "note-deleted";

  async function resolve(noteId: string, transient: Y.Doc | undefined): Promise<Resolved> {
    const s = states.get(noteId);
    if (s) return s.initialized ? { state: s, live: true } : "uninitialized";
    if (host?.documents.has(noteId)) return "uninitialized";
    if (!transient) return "uninitialized";
    const meta = await readVersionMeta(db, noteId);
    if (meta === null) return "note-deleted";
    if (deps.testHooks?.afterMetaRead) await deps.testHooks.afterMetaRead(noteId);
    return {
      live: false,
      state: {
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, editors: new Map(),
        loadFingerprint: loadFingerprintOf(meta, safeFingerprint(transient)), baseFingerprint: meta.baseFingerprint,
        applying: applyingSet.has(noteId), lastStoredFingerprint: null,
      },
    };
  }

  async function isDirty(noteId: string, doc: Y.Doc, transient?: Y.Doc): Promise<boolean> {
    const r = await resolve(noteId, transient);
    if (typeof r === "string") return true;
    const fp = safeFingerprint(doc);
    return fp === null ? true : dirtyOf(r.state, fp);
  }

  /** Shared by cutIfDirty and the scanner; `dueBy` is re-checked inside the transaction (not-due). */
  async function cutCore(noteId: string, doc: Y.Doc, opts: CutOptions & { dueBy?: Date }): Promise<CutOutcome> {
    const r = await resolve(noteId, opts.transient);
    if (r === "note-deleted") return { kind: "skipped", reason: "note-deleted" };
    if (r === "uninitialized") {
      if (!warnedUninitialized.has(noteId)) {
        warnedUninitialized.add(noteId);
        deps.log.warn({ noteId }, "版本狀態尚未初始化，略過切版");
      }
      return { kind: "skipped", reason: "uninitialized" };
    }
    const { state, live } = r;
    if (opts.kind === "auto") {
      if (state.applying) return { kind: "skipped", reason: "applying" };
      if (!state.autoEnabled) return { kind: "skipped", reason: "auto-disabled" };
    }
    const fp = safeFingerprint(doc);
    if (fp === null) {
      deps.log.warn({ noteId }, "版本指紋算不出來，略過切版");
      return { kind: "skipped", reason: "fingerprint-failed" };
    }
    if (opts.kind === "auto" && !dirtyOf(state, fp)) return { kind: "clean" };
    // Only the editors written into this version are removed afterwards.
    const written = [...state.editors.entries()];
    const input: CutVersionInput = {
      noteId,
      kind: opts.kind,
      name: opts.name ?? null,
      editors: toEditorsJson([...written.map(([, v]) => v), ...(opts.extraEditors ?? [])]),
      expectBaseFingerprint: state.baseFingerprint,
      expectSpaceKey: state.spaceKey,
      loadFingerprint: state.loadFingerprint,
      vacuumFingerprint: VACUUM_VERSION_FINGERPRINT,
      capture: () => ({ fp: versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT)), ydoc: Y.encodeStateAsUpdate(doc) }),
      keepExistingName: opts.keepExistingName ?? false,
      ...(opts.dueBy !== undefined ? { dueBy: opts.dueBy } : {}),
    };
    let out: Awaited<ReturnType<typeof cutVersionInTx>>;
    try {
      out = await db.transaction(tx => cutVersionInTx(tx, input));
    } catch (err) {
      if (!(err instanceof VersionCutAbort)) throw err;
      const reason = err.reason;
      if (reason.kind === "note-deleted") return { kind: "skipped", reason: "note-deleted" };
      if (reason.kind === "fingerprint-failed") {
        deps.log.warn({ noteId, err: reason.cause }, "版本指紋算不出來，略過切版");
        return { kind: "skipped", reason: "fingerprint-failed" };
      }
      if (reason.kind === "stale") {
        if (live && states.get(noteId) === state) {
          state.baseFingerprint = reason.baseFingerprint;
          state.spaceKey = reason.spaceKey;
        }
        return { kind: "stale" };
      }
      return reason.kind === "not-due" ? { kind: "not-due" } : { kind: "clean" };
    }
    if (live && states.get(noteId) === state) {
      state.baseFingerprint = out.fp;
      for (const [k] of written) state.editors.delete(k);
    }
    // An upgrade (base made manual) adds no row, so there is nothing to prune.
    if (!out.upgraded) {
      try {
        await pruneNote(noteId);
      } catch (err) {
        deps.log.warn({ err, noteId }, "切版後清除舊版本失敗");
      }
    }
    return { kind: "cut", row: out.row, upgraded: out.upgraded };
  }

  async function cutIfDirty(noteId: string, doc: Y.Doc, opts: CutOptions): Promise<CutResult> {
    const out = await cutCore(noteId, doc, opts);
    if (out.kind === "cut") return { row: out.row, upgraded: out.upgraded };
    if (out.kind === "skipped") return { skipped: out.reason };
    return null;
  }

  function beginApply(noteId: string): void {
    applyingSet.add(noteId);
    const s = states.get(noteId);
    if (s) s.applying = true;
  }

  function endApply(noteId: string, baseUpdate?: { seq: number; fingerprint: string } | { reset: true }): void {
    const s = states.get(noteId);
    if (baseUpdate === undefined) {
      applyingSet.delete(noteId);
      if (s) s.applying = false;
      return;
    }
    if (!s) return;
    if ("reset" in baseUpdate) {
      s.baseFingerprint = null;
      s.loadFingerprint = null; // next cut follows the no-base rule: anything non-vacuum counts as changed
      return;
    }
    s.baseFingerprint = baseUpdate.fingerprint;
    s.editors.clear();
  }

  async function docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }> {
    const live = host?.documents.get(noteId);
    if (live) return { doc: live };
    const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
    const doc = new Y.Doc();
    if (row) Y.applyUpdate(doc, row.ydoc);
    return { doc, transient: doc };
  }

  async function currentOf(noteId: string): Promise<VersionCurrentCore | null> {
    const meta = await readVersionMeta(db, noteId);
    if (meta === null) return null;
    const { doc, transient } = await docFor(noteId);
    const dirty = await isDirty(noteId, doc, transient);
    const s = states.get(noteId);
    return { baseSeq: meta.baseSeq, dirty, nextSeq: meta.counter + 1, autoEnabled: s?.initialized ? s.autoEnabled : meta.autoEnabled };
  }

  async function readDays(): Promise<{ keepAllDays: number; dailyUntilDays: number }> {
    const [r] = await db
      .select({ keepAllDays: siteSettings.versionKeepAllDays, dailyUntilDays: siteSettings.versionDailyUntilDays })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    return r ?? { keepAllDays: VERSION_KEEP_ALL_DAYS_DEFAULT, dailyUntilDays: VERSION_DAILY_UNTIL_DAYS_DEFAULT };
  }

  /** No transaction: the DELETE carries the `kind='auto'` and not-base predicates itself. */
  async function pruneNote(noteId: string, at: Date = now()): Promise<number> {
    const days = await readDays();
    const [note] = await db.select({ baseSeq: notes.versionBaseSeq }).from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!note) return 0;
    const rows = await db
      .select({ seq: noteVersions.seq, kind: noteVersions.kind, createdAt: noteVersions.createdAt })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const doomed = selectVersionsToDelete(rows, { now: at, keepAllDays: days.keepAllDays, dailyUntilDays: days.dailyUntilDays, baseSeq: note.baseSeq });
    if (deps.testHooks?.afterPruneRead) await deps.testHooks.afterPruneRead(noteId, doomed);
    let deleted = 0;
    for (let i = 0; i < doomed.length; i += PRUNE_DELETE_CHUNK) {
      const chunk = doomed.slice(i, i + PRUNE_DELETE_CHUNK);
      const gone = await db
        .delete(noteVersions)
        .where(and(
          eq(noteVersions.noteId, noteId),
          inArray(noteVersions.seq, chunk),
          eq(noteVersions.kind, "auto"),
          notBaseVersionSql(noteId),
        ))
        .returning({ seq: noteVersions.seq });
      deleted += gone.length;
    }
    return deleted;
  }

  async function sweep(at: Date): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const days = await readDays();
      const cutoff = new Date(at.getTime() - days.keepAllDays * DAY_MS);
      const candidates = await db
        .selectDistinct({ noteId: noteVersions.noteId })
        .from(noteVersions)
        .where(and(eq(noteVersions.kind, "auto"), lt(noteVersions.createdAt, cutoff), sweepCursor === null ? undefined : gt(noteVersions.noteId, sweepCursor)))
        .orderBy(asc(noteVersions.noteId))
        .limit(VERSION_SWEEP_BATCH);
      if (candidates.length === 0) {
        sweepCursor = null;
        return 0;
      }
      for (const c of candidates) {
        try {
          await pruneNote(c.noteId, at);
        } catch (err) {
          deps.log.warn({ err, noteId: c.noteId }, "版本清除背景掃描：單篇失敗，繼續下一篇");
        }
      }
      sweepCursor = candidates[candidates.length - 1]!.noteId;
      return candidates.length;
    } finally {
      sweeping = false;
    }
  }

  async function waitMsNow(): Promise<number> {
    if (overrideWaitMs !== null) return overrideWaitMs;
    if (deps.autoWaitMs !== undefined) return deps.autoWaitMs;
    const [r] = await db
      .select({ minutes: siteSettings.versionAutoWaitMinutes })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    return (r?.minutes ?? VERSION_AUTO_WAIT_MINUTES_DEFAULT) * 60_000;
  }

  /** A cut clears pending in its transaction; stale/not-due/applying/uninitialized retry next round. Throws to scanRound, which backs off. */
  async function cutDue(noteId: string, dueBy: Date): Promise<void> {
    if (deps.testHooks?.beforeCutDue) await deps.testHooks.beforeCutDue(noteId);
    const { doc, transient } = await docFor(noteId);
    const out = await cutCore(noteId, doc, { kind: "auto", transient, dueBy });
    const settled = out.kind === "clean" || (out.kind === "skipped" && (out.reason === "auto-disabled" || out.reason === "fingerprint-failed"));
    if (settled) await clearPendingIfDue(db, noteId, dueBy);
  }

  async function scanRound(at: Date): Promise<number> {
    const dueBy = new Date(at.getTime() - (await waitMsNow()));
    for (const [id, until] of backoff) if (until <= at.getTime()) backoff.delete(id);
    const held = [...backoff.keys()];
    const due = await db
      .select({ id: notes.id })
      .from(notes)
      // #181: skip trashed notes; pending stays, so they resume after restore.
      .where(and(lte(notes.versionPendingAt, dueBy), held.length > 0 ? notInArray(notes.id, held) : undefined, isNull(notes.deletedAt)))
      .orderBy(asc(notes.versionPendingAt), asc(notes.id))
      .limit(VERSION_AUTO_SCAN_BATCH);
    // Expired entries are pruned and unexpired ones excluded above, so a processed note is never in backoff;
    // the has()/delete() below are a second safeguard.
    for (const { id } of due) {
      if (stopping) break;
      try {
        await cutDue(id, dueBy);
        backoff.delete(id);
      } catch (err) {
        if (!backoff.has(id)) deps.log.warn({ err, noteId: id }, "自動切版：單篇失敗，10 分鐘後再試");
        backoff.set(id, at.getTime() + VERSION_AUTO_SCAN_BACKOFF_MS);
      }
    }
    return due.length;
  }

  function scanDue(at: Date = now()): Promise<number> {
    if (scanInflight !== null || stopping) return Promise.resolve(0);
    const round = scanRound(at).finally(() => {
      scanInflight = null;
    });
    scanInflight = round;
    return round;
  }

  function stopScan(): Promise<void> {
    stopping = true;
    return scanInflight === null ? Promise.resolve() : scanInflight.then(() => undefined, () => undefined);
  }

  async function noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void> {
    const c = ctx as Partial<DirectCtx> | undefined;
    if (c?.source === "version-apply" && c.applied === true) {
      // Every apply store clears pending (success, reset, failed base write-back); applied content isn't a change.
      await clearPending(db, noteId);
      const s = states.get(noteId);
      if (s?.initialized) s.lastStoredFingerprint = safeFingerprint(doc);
      return;
    }
    // Includes rejected direct writes (applied=false): that store replaced the same people's pending lastContext.
    const s = states.get(noteId);
    if (!s?.initialized) return; // relocation gap or failed load
    const fp = safeFingerprint(doc);
    if (fp === null || fp === s.lastStoredFingerprint) return;
    if (!s.autoEnabled) {
      s.lastStoredFingerprint = fp; // editors stay buffered for a manual save
      return;
    }
    const flushed = [...s.editors.entries()];
    const writer = c?.source === "ai-edit" && c.applied === true && typeof c.userId === "string" ? [{ userId: c.userId, agentLabel: c.agentLabel ?? null }] : [];
    const add = toEditorsJson([...flushed.map(([, v]) => v), ...writer]);
    await markPending(db, { noteId, at: now(), add, ref: s.loadFingerprint, spaceKey: s.spaceKey });
    s.lastStoredFingerprint = fp;
    for (const [k] of flushed) s.editors.delete(k);
  }

  function debugState(noteId: string): VersionStateSnapshot | undefined {
    const s = states.get(noteId);
    if (!s) return undefined;
    return {
      initialized: s.initialized, autoEnabled: s.autoEnabled, spaceKey: s.spaceKey, editors: [...s.editors.values()],
      loadFingerprint: s.loadFingerprint, baseFingerprint: s.baseFingerprint, applying: s.applying, lastStoredFingerprint: s.lastStoredFingerprint,
    };
  }

  return {
    bind: h => {
      host = h;
    },
    noteLoaded, noteChanged, forget, relocated, isDirty, cutIfDirty, beginApply, endApply, docFor, currentOf, pruneNote, sweep, debugState,
    noteStored, scanDue, stopScan,
    overrideAutoWaitMs: ms => {
      overrideWaitMs = ms;
    },
  };
}
