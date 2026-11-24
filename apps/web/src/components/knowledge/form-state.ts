import {
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_WHEN_MAX,
  isKnowledgeFieldEnabled,
  knowledgeOption,
  knowledgeStateOf,
  knowledgeTextLength,
  type KnowledgeBuiltinFieldKey,
  type KnowledgeDraft,
  type KnowledgeDraftError,
  type KnowledgeFieldView,
  type KnowledgeInfo,
} from "@knotebook/shared";

// Frozen, custom included: a spread copies the custom object by reference, so it must not be written through.
export const EMPTY_DRAFT: Readonly<KnowledgeDraft> = Object.freeze({
  when: "", conclusion: "", evidence: "", verified: "", state: "needs-verify", supersededBy: "", custom: Object.freeze({}) as Record<string, string>,
});

export type DraftField = Exclude<keyof KnowledgeDraft, "state" | "custom">;

/** In form order. */
export const DRAFT_FIELDS: readonly DraftField[] = ["when", "conclusion", "evidence", "verified", "supersededBy"];

const SETTING_KEY = {
  when: "when",
  conclusion: "conclusion",
  evidence: "evidence",
  verified: "verified",
  supersededBy: "superseded_by",
} as const satisfies Record<DraftField, KnowledgeBuiltinFieldKey>;

export function isDraftFieldEnabled(fields: KnowledgeFieldView, field: DraftField): boolean {
  return isKnowledgeFieldEnabled(fields, SETTING_KEY[field]);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A stored key that is hidden or no longer defined is still shown, marked as turned off, so the value isn't mistaken for empty. */
export function evidenceLabel(fields: KnowledgeFieldView, key: string, t: Translate): string {
  if (key === "") return t("knowledge.notFilled");
  const option = knowledgeOption(fields, "evidence", key);
  const name = option ? (option.name ?? (option.builtin ? t(`knowledge.evidence.${key}`) : key)) : key;
  return option?.enabled ? name : t("knowledge.turnedOff", { name });
}

export function draftOf(info: KnowledgeInfo | null): KnowledgeDraft {
  if (!info) return { ...EMPTY_DRAFT, custom: {} };
  const { when, conclusion, evidence, verified, supersededBy } = info;
  return { when, conclusion, evidence, verified, state: knowledgeStateOf(info), supersededBy, custom: { ...info.custom } };
}

/** A single-line input can't show a line break written elsewhere; the stored value stays as it is until the field is edited. */
export function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** A replacement only means something for outdated knowledge. */
export function draftForSave(draft: KnowledgeDraft): KnowledgeDraft {
  return draft.state === "obsolete" ? draft : { ...draft, supersededBy: "" };
}

export type FormField = keyof KnowledgeDraft | "form";

export function fieldOfError(error: KnowledgeDraftError | "clearedAll"): FormField {
  switch (error) {
    case "clearedAll": return "form";
    case "whenTooLong": return "when";
    case "conclusionTooLong": return "conclusion";
    case "verifiedInvalid": return "verified";
    case "supersededInvalid":
    case "supersededSelf": return "supersededBy";
  }
}

/** Set only for a field the user edited: a long value written elsewhere must not block saving another field. */
export function tooLongLength(field: "when" | "conclusion", draft: KnowledgeDraft, touched: ReadonlySet<keyof KnowledgeDraft>): { max: number; n: number } | null {
  if (!touched.has(field)) return null;
  const max = field === "when" ? KNOWLEDGE_WHEN_MAX : KNOWLEDGE_CONCLUSION_MAX;
  const n = knowledgeTextLength(draft[field]);
  return n > max ? { max, n } : null;
}
