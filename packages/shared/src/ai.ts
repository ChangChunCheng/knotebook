// Built-in action ids are fixed literals: the seed relies on ON CONFLICT (id) DO NOTHING, and the
// rows already exist in deployed databases, so changing an id creates a different action.
export const REWRITE_ACTION_ID = "ab0a1517-bec1-4709-b13f-756548375b86";
export const TRANSLATE_ACTION_ID = "362788cb-d2f0-41ce-b697-c929b67bf20e";
export const SUMMARIZE_ACTION_ID = "2e37a47e-a6cd-4f14-b2f6-0cdebd715b2a";
export const CONTINUE_WRITING_ACTION_ID = "4a8e18da-1d9c-4be1-ba32-a0c5429b0a22";
export const INSTRUCT_ACTION_ID = "58ef60fd-e99e-4f19-aa57-6fea5e652749";

export const BUILTIN_ACTION_IDS: readonly string[] = [
  REWRITE_ACTION_ID,
  TRANSLATE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCT_ACTION_ID,
];

/** Limits in code points; `instruction` is measured after trim. */
export const INSTRUCTION_MAX_CODE_POINTS = 500;
export const FOCUS_MAX_CODE_POINTS = 2000;

export type AiActionKind = "quick" | "instruct";

export function aiActionKind(actionId: string): AiActionKind {
  return actionId === INSTRUCT_ACTION_ID ? "instruct" : "quick";
}

/** Array.from iterates code points; `.length` counts UTF-16 units (an emoji is 2). */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function truncateCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}
