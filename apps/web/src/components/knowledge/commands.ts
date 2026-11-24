import type { BlockNoteEditor } from "@blocknote/core";
import {
  EMPTY_KNOWLEDGE_PROPS,
  generateKnowledgeId,
  knowledgeInfoToProps,
  knowledgeStateOf,
  listKnowledgeInBlocks,
  normalizeKnowledgeText,
  readKnowledgeInfo,
  storedStatusOf,
  validateKnowledgeDraft,
  type KnowledgeDraft,
  type KnowledgeDraftError,
  type KnowledgeFieldView,
  type KnowledgeInfo,
  type KnowledgePropName,
} from "@knotebook/shared";
import { DRAFT_FIELDS, EMPTY_DRAFT, isDraftFieldEnabled, type DraftField } from "./form-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

export type SaveKnowledgeResult = { ok: true; knowledgeId: string } | { ok: false; reason: KnowledgeDraftError | "notEligible" | "clearedAll" };

type Patch = Partial<Record<KnowledgePropName, string>>;

/** Only a heading outside columns, lists and quotes can be knowledge. */
export function isKnowledgeEligible(editor: AnyEditor, blockId: string): boolean {
  try {
    const block = editor.getBlock(blockId);
    return block !== undefined && block.type === "heading" && editor.getParentBlock(blockId) === undefined;
  } catch {
    // The view isn't mounted (any more): there is nothing to write to.
    return false;
  }
}

export function currentKnowledgeTarget(editor: AnyEditor): string | null {
  try {
    const id = editor.getTextCursorPosition().block.id;
    return isKnowledgeEligible(editor, id) ? id : null;
  } catch {
    return null;
  }
}

export function todayLocalDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function writable(editor: AnyEditor, blockId: string): boolean {
  return editor.isEditable && isKnowledgeEligible(editor, blockId);
}

function currentInfo(editor: AnyEditor, blockId: string): KnowledgeInfo | null {
  return readKnowledgeInfo(editor.getBlock(blockId)?.props as Record<string, unknown> | undefined);
}

const PROP_OF = {
  when: "knowledgeWhen",
  conclusion: "knowledgeConclusion",
  evidence: "knowledgeEvidence",
  verified: "knowledgeVerified",
  supersededBy: "knowledgeSupersededBy",
} as const satisfies Record<DraftField, KnowledgePropName>;

function stored(field: DraftField, value: string): string {
  return field === "when" || field === "conclusion" ? normalizeKnowledgeText(value) : value.trim();
}

// A replacement only exists alongside outdated, and the state must be needs review for the prompt, so it never counts here.
const CLEARABLE_FIELDS: readonly DraftField[] = ["when", "conclusion", "evidence", "verified"];

/** Saving would leave existing knowledge with nothing but the default status: more likely a slip than a wish to keep an empty entry. */
export function isClearedAll(base: KnowledgeInfo | null, draft: KnowledgeDraft, fields: KnowledgeFieldView): boolean {
  if (!base || draft.state !== "needs-verify") return false;
  const shown = CLEARABLE_FIELDS.filter((f) => isDraftFieldEnabled(fields, f));
  return shown.some((f) => stored(f, base[f]) !== "") && shown.every((f) => stored(f, draft[f]) === "");
}

/**
 * A single `updateBlock`, so one undo step restores the whole edit. A change to a heading saved without a status writes the explicit
 * status with it: that heading is read through its verified date, so clearing the date would otherwise turn it into needs review.
 * Props of turned-off fields are never written.
 */
export function saveKnowledge(
  editor: AnyEditor,
  blockId: string,
  base: KnowledgeInfo | null,
  draft: KnowledgeDraft,
  noteId: string | null,
  fields: KnowledgeFieldView,
  touched?: ReadonlySet<keyof KnowledgeDraft>,
): SaveKnowledgeResult {
  if (!writable(editor, blockId)) return { ok: false, reason: "notEligible" };
  const shown = DRAFT_FIELDS.filter((f) => isDraftFieldEnabled(fields, f));
  const current = currentInfo(editor, blockId);
  const selfId = current?.id ?? base?.id ?? null;
  // A stored value the form doesn't show can't be corrected there, so it must not block saving.
  const checked: KnowledgeDraft = { ...EMPTY_DRAFT, state: draft.state, custom: {} };
  for (const field of shown) checked[field] = draft[field];
  const invalid = validateKnowledgeDraft(checked, selfId ? { noteId: null, knowledgeId: selfId } : null, noteId, touched);
  if (invalid) return { ok: false, reason: invalid };
  if (isClearedAll(base, draft, fields)) return { ok: false, reason: "clearedAll" };

  const patch: Patch = {};
  const currentProps = current ? knowledgeInfoToProps(current) : null;
  const stateChanged = base === null || knowledgeStateOf(base) !== draft.state;
  let fieldChanged = false;
  for (const field of shown) {
    // Compared before normalizing: an untouched value written elsewhere (say with line breaks) must not be rewritten.
    if (base ? base[field] === draft[field] : draft[field] === "") continue;
    fieldChanged = true;
    const value = stored(field, draft[field]);
    if (currentProps?.[PROP_OF[field]] !== value) patch[PROP_OF[field]] = value;
  }
  // The knowledge was removed while the form was open: nothing is left to keep, so every filled field is written again.
  if (!current && base) {
    for (const field of shown) {
      const value = stored(field, draft[field]);
      if (value !== "") patch[PROP_OF[field]] = value;
    }
  }
  const status = storedStatusOf(draft.state);
  // An explicit status a collaborator set while the form was open is theirs to keep unless this form changed the state.
  const settleLegacy = fieldChanged && currentProps?.knowledgeStatus === "";
  if ((stateChanged || !current || settleLegacy) && currentProps?.knowledgeStatus !== status) patch.knowledgeStatus = status;

  let knowledgeId = current?.id ?? "";
  if (!current) {
    const taken = new Set(listKnowledgeInBlocks(editor.document as never).map((e) => e.info.id));
    // Keeping the id lets links that point at it survive a collaborator's removal of the info.
    knowledgeId = base && !taken.has(base.id) ? base.id : generateKnowledgeId(taken);
    patch.knowledgeId = knowledgeId;
  }
  if (Object.keys(patch).length > 0) editor.updateBlock(blockId, { props: patch } as never);
  return { ok: true, knowledgeId };
}

/** Outdated knowledge has no date worth refreshing. */
export function markKnowledgeVerified(editor: AnyEditor, blockId: string, fields: KnowledgeFieldView, now: Date = new Date()): boolean {
  if (!writable(editor, blockId)) return false;
  const current = currentInfo(editor, blockId);
  if (!current || knowledgeStateOf(current) === "obsolete") return false;
  const patch: Patch = { knowledgeStatus: "verified" };
  if (isDraftFieldEnabled(fields, "verified")) patch.knowledgeVerified = todayLocalDate(now);
  editor.updateBlock(blockId, { props: patch } as never);
  return true;
}

export function removeKnowledge(editor: AnyEditor, blockId: string): boolean {
  if (!writable(editor, blockId) || !currentInfo(editor, blockId)) return false;
  editor.updateBlock(blockId, { props: { ...EMPTY_KNOWLEDGE_PROPS } } as never);
  return true;
}
