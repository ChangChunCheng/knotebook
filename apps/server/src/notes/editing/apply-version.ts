import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import { clearVersionBase, setVersionBase, type VersionService } from "../../collab/versions.js";
import { noteVersions } from "../../db/schema.js";
import { capBlocks, NoteTooLargeError } from "../note-size.js";
import { DOC_TOO_COMPLEX } from "./doc-jobs.js";
import { FingerprintMismatch, forkAndCheck, mergeDiff, prepareEdit, updateNoteLinks, type ApplyDeps, type MergeOutput } from "./apply.js";
import type { DirectCtx } from "./session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
type AnyPartialBlock = PartialBlock<any, any, any>;

export type ApplyVersionFailureCode = "not_found" | "version_mismatch" | "version_unsaved_changes";
export interface ApplyVersionInput {
  noteId: string;
  seq: number;
  /** Lowercased by the route (compared with `!==` against `row.id`). */
  versionId: string;
  userId: string;
  discardUnsaved: boolean;
}
export type ApplyVersionDeps = ApplyDeps & { versions: VersionService };

/**
 * Creating the editor and reading blocks must stay in one synchronous section: EditingRuntime swaps the global window/document in a lease release, which can only happen after an await. No test catches a split.
 */
export function blocksFromSnapshot(baseUrl: string, ydoc: Uint8Array): AnyPartialBlock[] {
  const snapshot = new Y.Doc();
  Y.applyUpdate(snapshot, ydoc);
  const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema(baseUrl) });
  return yXmlFragmentToBlocks(editor, snapshot.getXmlFragment(YDOC_FRAGMENT)) as AnyPartialBlock[];
}

/** Race with pruning: the base may point at a version just deleted; `setVersionBase`'s UPDATE has `WHERE EXISTS`, so 0 rows resets the base. */
async function writeBaseAfterApply(deps: ApplyVersionDeps, input: ApplyVersionInput, out: MergeOutput): Promise<void> {
  if (deps.testHooks?.beforeVersionBase) await deps.testHooks.beforeVersionBase();
  const fp = out.versionFingerprint;
  if (fp !== null && (await setVersionBase(deps.db, input.noteId, input.seq, fp, input.versionId))) {
    deps.versions.endApply(input.noteId, { seq: input.seq, fingerprint: fp });
    return;
  }
  deps.log.warn({ noteId: input.noteId, seq: input.seq, fingerprintFailed: fp === null }, "套用後基底無法指向該版（版本已被刪或指紋算不出來），基底改為無");
  await clearVersionBase(deps.db, input.noteId);
  deps.versions.endApply(input.noteId, { reset: true });
}

export async function applyVersionEdit(deps: ApplyVersionDeps, input: ApplyVersionInput): Promise<{ ok: true } | { ok: false; code: ApplyVersionFailureCode }> {
  const [row] = await deps.db
    .select({ id: noteVersions.id, ydoc: noteVersions.ydoc })
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, input.seq)))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };
  if (row.id !== input.versionId) return { ok: false, code: "version_mismatch" };
  const blocks = blocksFromSnapshot(deps.editing.baseUrl, row.ydoc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const f = await forkAndCheck(deps, input.noteId);
    // The retry reruns isDirty too, so with discardUnsaved:false an edit that slipped in gets 409.
    if (!input.discardUnsaved && (await deps.versions.isDirty(input.noteId, f.fork, f.fork))) return { ok: false, code: "version_unsaved_changes" };
    deps.versions.beginApply(input.noteId);
    try {
      const baseState = deps.noteMaxBytes === undefined ? null : Y.encodeStateAsUpdate(f.fork);
      const prepared = await prepareEdit(
        deps,
        { noteId: input.noteId, userId: input.userId, tokenId: null, agentLabel: null, op: "replace_all", candidates: [], blocks, unbound: 0 },
        f.fork,
        f.sv,
        { op: "replace_all", isEmptyDoc: f.isEmptyDoc, section: undefined },
      );
      if ("error" in prepared) throw new Error(`套用版本時 prepare 失敗：${prepared.error}`);
      // Size cap is measured on a fresh doc in the parse worker (the editor's undo history would keep deleted content alive otherwise). If the trial fails (timeout/OOM), fall back to the bound base + 2×diff + 64.
      if (deps.noteMaxBytes !== undefined && baseState !== null) {
        const baseBytes = baseState.byteLength; // the pool transfers this buffer: record its length first
        const diffBytes = prepared.diff.byteLength;
        const m = await deps.editing.runDoc(input.userId, { kind: "sizeTrial", state: baseState, update: prepared.diff.slice() });
        if (m === DOC_TOO_COMPLEX) {
          if (baseBytes + 2 * diffBytes + 64 > deps.noteMaxBytes) throw new NoteTooLargeError(deps.noteMaxBytes, baseBytes + diffBytes);
        } else if (capBlocks(m, deps.noteMaxBytes)) throw new NoteTooLargeError(deps.noteMaxBytes, m.stateAfter);
      }
      if (deps.testHooks?.beforeMerge) await deps.testHooks.beforeMerge();
      const ctx: DirectCtx = { source: "version-apply", userId: input.userId, tokenId: null, agentLabel: null, applied: false };
      const merged = await mergeDiff(
        deps,
        input.noteId,
        ctx,
        { targetIds: null, expectFingerprint: f.whole, anchorId: null, diff: prepared.diff, afterIds: prepared.afterIds },
        { beforeDisconnect: out => writeBaseAfterApply(deps, input, out) },
      );
      await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, forkDoc: f.fork, clock: merged.clock });
      return { ok: true };
    } catch (err) {
      if (err instanceof FingerprintMismatch) continue;
      throw err;
    } finally {
      deps.versions.endApply(input.noteId); // endApply(r) doesn't clear `applying`; only this line after disconnect (persisted) does
    }
  }
  return { ok: false, code: "version_unsaved_changes" };
}
