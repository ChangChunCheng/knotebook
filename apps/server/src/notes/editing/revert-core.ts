import type { Block, PartialBlock } from "@blocknote/core";
import type * as Y from "yjs";
import { topLevelContainers } from "@knotebook/shared";
import { fingerprintForIds } from "./fingerprint.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, replaceBlocksFresh } from "./session.js";

export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };

/** `listEdits` has a SQL copy of this condition (`revert.ts`). */
export function isDeleteShape(row: { op: string; anchor: unknown }): boolean {
  return row.op === "delete_section" || (row.op === "file_sync" && row.anchor !== null && row.anchor !== undefined);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyPartialBlock = PartialBlock<any, any, any>;

export interface RevertRow {
  op: string;
  afterBlockIds: string[];
  afterFingerprint: string | null;
  beforeBlocks: unknown[];
  anchor: Anchor | null;
}

export const topLevelIds = (fragment: Y.XmlFragment): (string | null)[] => topLevelContainers(fragment).map(c => c.getAttribute("id") ?? null);

export type RevertableRow = {
  op: string;
  afterBlockIds: string[];
  afterFingerprint: string | null;
  anchorId: string | null;
  beforeIds: string[];
};

/**
 * Single criterion for "can still be reverted", shared by `listEdits` (display) and `revertEdit`'s pre-check, so the list never says yes where the click 409s.
 * `delete_section` has no after-fingerprint, so it needs the anchor at top level and none of the `before_blocks` ids at top level (= not yet restored). The revert endpoint has no `if_match`, so this is its idempotency guard: a retry after a mid-way failure would otherwise insert `before_blocks` twice → duplicate top-level ids, with a 201. A browser Ctrl-Z restoring the section also hits this (Yjs undo reuses ids) and rightly means "already restored".
 * Relies on same-note writes being serialized (`queue.ts`): the pre-check reads the live doc before the merge.
 */
export const editRevertable = (row: RevertableRow, fragment: Y.XmlFragment, topIds: readonly (string | null)[]): boolean =>
  isDeleteShape({ op: row.op, anchor: row.anchorId })
    ? row.anchorId !== null && topIds.includes(row.anchorId) && !row.beforeIds.some(id => topIds.includes(id))
    : row.afterBlockIds.length > 0 && fingerprintForIds(fragment, row.afterBlockIds) === row.afterFingerprint;

export async function prepareRevertOnFork(
  runtime: EditingRuntime,
  row: RevertRow,
  fork: Y.Doc,
  sv: Uint8Array,
  othersShareAnchor = false,
): Promise<{ diff: Uint8Array; reinsertedIds: string[]; removedSnapshot: AnyBlock[] }> {
  const anchor = row.anchor;
  const s = await EditorSession.open(runtime, fork);
  try {
    const ed = s.editor;
    const before = row.beforeBlocks as AnyPartialBlock[];
    const removedSnapshot: AnyBlock[] = row.afterBlockIds.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
    let reinsertedIds: string[] = [];
    const wouldBeEmpty = (removing: string[]) => ed.document.every(b => removing.includes(b.id));
    const revertReplace = () => {
      if (before.length === 0 && wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]);
      else reinsertedIds = replaceBlocksFresh(ed, row.afterBlockIds, before).map(b => b.id);
    };
    const revertInsert = () => {
      // No test fails if this becomes an unconditional `removeBlocks` (normalization re-adds a paragraph), but "top level is never empty" is this path's own invariant; relying on normalization write-back is a known trap (#100).
      if (wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]); else ed.removeBlocks(row.afterBlockIds);
    };
    const revertDelete = (removeAnchor: (isEmptyParagraph: boolean) => boolean) => {
      reinsertedIds = ed.insertBlocks(before, anchor!.block_id, anchor!.position).map(b => b.id);
      const a = ed.getBlock(anchor!.block_id);
      const isEmptyParagraph = a !== undefined && a.type === "paragraph" && (!Array.isArray(a.content) || a.content.length === 0) && (!Array.isArray(a.children) || a.children.length === 0);
      if (removeAnchor(isEmptyParagraph)) ed.removeBlocks([anchor!.block_id]);
    };
    switch (row.op) {
      case "replace_all": case "replace_section": revertReplace(); break;
      case "insert_after": case "append": revertInsert(); break;
      case "delete_section": revertDelete(isEmpty => anchor!.position === "before" && isEmpty); break;
      case "file_sync": {
        // Only a placeholder that is still an empty paragraph and shared by no other unreverted row is removed; a user's own empty paragraph is never an anchor.
        if (isDeleteShape({ op: row.op, anchor })) revertDelete(isEmpty => anchor!.placeholder === true && isEmpty && !othersShareAnchor);
        else if (before.length > 0) revertReplace();
        else revertInsert();
        break;
      }
    }
    return { diff: s.diffSince(sv), reinsertedIds, removedSnapshot };
  } finally {
    s.close();
  }
}
