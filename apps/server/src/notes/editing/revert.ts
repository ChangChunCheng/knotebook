// `revert_of` is ON DELETE CASCADE and interacts with RETENTION trimming: reverting the oldest row trims the original and its revert row cascades away (99, not 100), and an ordinary write's trim can likewise delete a revert row inside the window. So "keep 100" means "at most 100".
import { and, desc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { YDOC_FRAGMENT, sectionize, type NoteEditDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { apiTokens, noteAiEdits, users } from "../../db/schema.js";
import { agentLabelOf } from "../../auth/agent-label.js";
import { readAvatarRefs } from "../../avatars/read.js";
import { DOC_MERGE_ATTEMPTS, RETENTION, StaleBase, mergeAtBase, recordableAfter, updateNoteLinks, type ApplyDeps, type MergeOutput } from "./apply.js";
import { DOC_TOO_COMPLEX } from "./doc-jobs.js";
import { ParserBusyError } from "./parse-core.js";
import { loadNoteDoc, loadNoteState } from "./read.js";
import { editRevertable, topLevelIds, type Anchor, type RevertRow } from "./revert-core.js";
import type { DirectCtx } from "./session.js";

export { isDeleteShape } from "./revert-core.js";



export async function listEdits(deps: { db: Db; collab?: CollabServer }, noteId: string): Promise<NoteEditDto[]> {
  // Select columns individually: `before_blocks` is the full pre-edit snapshot (unbounded, up to 100 × note size) and the response never uses it. Adding a DTO field requires adding it here (typecheck fails otherwise). No test fails if this selects the whole table.
  const rows = await deps.db.select({
    id: noteAiEdits.id, userId: noteAiEdits.userId, op: noteAiEdits.op, sectionId: noteAiEdits.sectionId, tokenId: noteAiEdits.tokenId,
    agentLabelSnapshot: noteAiEdits.agentLabel, afterBlockIds: noteAiEdits.afterBlockIds, afterFingerprint: noteAiEdits.afterFingerprint,
    anchor: noteAiEdits.anchor, revertOf: noteAiEdits.revertOf, revertedAt: noteAiEdits.revertedAt, createdAt: noteAiEdits.createdAt,
    handle: users.handle, tokenName: apiTokens.name, tokenLabel: apiTokens.agentLabel,
    // `editRevertable` needs only the ids of `before_blocks`, so extract them as text[] in SQL (CASE is lazy, so only delete_section rows pay the detoast). Same condition as `isDeleteShape`.
    beforeBlockIds: sql<string[]>`case when ${noteAiEdits.op} = 'delete_section' or (${noteAiEdits.op} = 'file_sync' and ${noteAiEdits.anchor} is not null) then coalesce((select array_agg(b->>'id') from jsonb_array_elements(${noteAiEdits.beforeBlocks}) as b), '{}'::text[]) else '{}'::text[] end`,
  })
    .from(noteAiEdits).innerJoin(users, eq(users.id, noteAiEdits.userId)).leftJoin(apiTokens, eq(apiTokens.id, noteAiEdits.tokenId))
    .where(eq(noteAiEdits.noteId, noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id));
  const avatars = await readAvatarRefs(deps.db, rows.map(e => e.userId));
  const { doc } = await loadNoteDoc(deps, noteId);
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const topIds = topLevelIds(fragment);
  const sections = sectionize(fragment);
  return rows.map(e => {
    const anchor = e.anchor as Anchor | null;
    const revertable = e.op !== "revert" && e.revertedAt === null && editRevertable(
      { op: e.op, afterBlockIds: e.afterBlockIds, afterFingerprint: e.afterFingerprint, anchorId: anchor?.block_id ?? null, beforeIds: e.beforeBlockIds },
      fragment, topIds,
    );
    const probe = e.afterBlockIds[0] ?? anchor?.block_id;
    const heading = probe === undefined ? "" : sections.find(s => s.blockIds.includes(probe))?.heading ?? "";
    // Pure-predicate `agentLabelOf`, not the route's `currentAgentLabel`: a per-row lookup would be N+1 (up to 100 rows).
    const agentLabel = e.tokenId !== null && e.tokenName !== null ? agentLabelOf({ agentLabel: e.tokenLabel, name: e.tokenName }) : e.agentLabelSnapshot;
    return { id: e.id, op: e.op as NoteEditDto["op"], sectionId: e.sectionId, heading, byHandle: e.handle, agentLabel, avatar: avatars.get(e.userId) ?? null, createdAt: e.createdAt.toISOString(), revertedAt: e.revertedAt?.toISOString() ?? null, revertOf: e.revertOf, revertable };
  });
}

export type RevertResult = { ok: true; editId: string; fingerprint: string; outline: MergeOutput["outline"] } | { ok: false; code: "not_found" | "already_reverted" | "stale" | "too_complex" };

export async function revertEdit(deps: ApplyDeps, input: { noteId: string; editId: string; userId: string; tokenId: string | null; agentLabel: string | null }): Promise<RevertResult> {
  const [row] = await deps.db.select().from(noteAiEdits).where(and(eq(noteAiEdits.id, input.editId), eq(noteAiEdits.noteId, input.noteId)));
  if (!row) return { ok: false, code: "not_found" };
  if (row.op === "revert" || row.revertedAt !== null) return { ok: false, code: "already_reverted" };
  const anchor = row.anchor as Anchor | null;
  const othersShareAnchor =
    row.op === "file_sync" && anchor?.placeholder === true
      ? (
          await deps.db
            .select({ id: noteAiEdits.id })
            .from(noteAiEdits)
            .where(and(eq(noteAiEdits.noteId, input.noteId), ne(noteAiEdits.id, row.id), isNull(noteAiEdits.revertedAt), sql`${noteAiEdits.anchor}->>'block_id' = ${anchor.block_id}`))
            .limit(1)
        ).length > 0
      : false;
  const revertRow: RevertRow = { op: row.op, afterBlockIds: row.afterBlockIds, afterFingerprint: row.afterFingerprint, beforeBlocks: row.beforeBlocks as unknown[], anchor };
  let merged: MergeOutput | null = null;
  let reinsertedIds: string[] = [];
  let removedSnapshot: unknown[] = [];
  let linkTargets: string[] = [];
  for (let attempt = 0; attempt < DOC_MERGE_ATTEMPTS && merged === null; attempt++) {
    const { state, watch } = await loadNoteState(deps, input.noteId, { watch: true });
    let r: Exclude<Awaited<ReturnType<typeof deps.editing.runDoc<"revert">>>, typeof DOC_TOO_COMPLEX>;
    try {
      const extra = JSON.stringify(row.beforeBlocks ?? []).length;
      const out = await deps.editing.runDoc(input.userId, { kind: "revert", state, row: revertRow, othersShareAnchor }, { extraWeight: extra });
      // Revert has no parse step: a worker timeout/OOM means the note itself is too large; retrying is useless, so no 503; content and records are untouched.
      if (out === DOC_TOO_COMPLEX) return { ok: false, code: "too_complex" };
      if (!out.ok) return { ok: false, code: "stale" };
      r = out;
      const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
      try {
        merged = await mergeAtBase(deps, input.noteId, ctx, r.post, watch);
      } catch (err) {
        if (err instanceof StaleBase) continue;
        throw err;
      }
    } finally {
      watch?.stop();
    }
    reinsertedIds = r.reinsertedIds;
    removedSnapshot = r.removedSnapshot;
    linkTargets = r.post.linkTargets;
  }
  if (merged === null) throw new ParserBusyError();
  const done: MergeOutput = merged;
  if (deps.testHooks?.beforeRevertRecord) await deps.testHooks.beforeRevertRecord();
  const editId = await deps.db.transaction(async tx => {
    const [ins] = await tx.insert(noteAiEdits).values({
      noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: "revert", sectionId: row.sectionId,
      beforeBlocks: removedSnapshot, anchor: null, revertOf: row.id,
      ...recordableAfter(deps, input.noteId, reinsertedIds, done.afterFingerprint),
    }).returning({ id: noteAiEdits.id });
    await tx.update(noteAiEdits).set({ revertedAt: new Date() }).where(eq(noteAiEdits.id, row.id));
    // Same trim rule as `insertEditRecord` but can't reuse it: revert inserts the revert row, marks the original `reverted_at` and trims in one transaction. Keep orderBy/limit identical.
    const keep = await tx.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, input.noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id)).limit(RETENTION);
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, input.noteId), notInArray(noteAiEdits.id, keep.map(k => k.id))));
    return ins!.id;
  });
  await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, targets: linkTargets, clock: done.clock });
  return { ok: true, editId, fingerprint: done.fingerprint, outline: done.outline };
}

