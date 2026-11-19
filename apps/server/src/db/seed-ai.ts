import {
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCT_ACTION_ID,
  REWRITE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  TRANSLATE_ACTION_ID,
} from "@knotebook/shared";
import type { Db } from "./index.js";
import { aiActions } from "./schema.js";

/**
 * `name` is DB data shown as-is (admins can rename it), not an i18n key. All default to preview; the seed only
 * inserts missing ids, so existing sites keep their apply modes. Instruct's systemPrompt only sets tone: routes/ai.ts
 * wraps the placeholders and prepends the fixed guard from ai/instruct.ts.
 */
const BUILTIN_ACTIONS = [
  {
    id: REWRITE_ACTION_ID,
    name: "Rewrite",
    systemPrompt:
      "You are an expert editor. Rewrite the user's text to improve clarity and flow while preserving its meaning, language, and Markdown formatting. Reply with the rewritten text only.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 0,
  },
  {
    id: TRANSLATE_ACTION_ID,
    name: "Translate",
    systemPrompt:
      "Translate the user's text: if it is mostly Chinese, translate to English; otherwise translate to Traditional Chinese. Preserve Markdown formatting. Reply with the translation only.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 1,
  },
  {
    id: SUMMARIZE_ACTION_ID,
    name: "Summarize",
    systemPrompt: "Summarize the user's text concisely in its own language, preserving the key points. Reply with the summary only, in Markdown.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 2,
  },
  {
    id: CONTINUE_WRITING_ACTION_ID,
    name: "Continue writing",
    systemPrompt:
      "Continue writing from where the user's text ends, matching its language, tone, and Markdown formatting. Reply with the complete text: the original followed by your continuation.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 3,
  },
  {
    id: INSTRUCT_ACTION_ID,
    name: "Instruct",
    systemPrompt:
      "You are an expert editor working on a note. Follow the user's instruction for the given text, preserving its language and Markdown formatting unless the instruction says otherwise.",
    userTemplate: "{{instruction}}\n{{focus}}\n{{text}}",
    applyMode: "preview" as const,
    sortOrder: 4,
  },
];

/** Inserts only missing ids, so admin edits (prompts, disabling) are never overwritten or revived. */
export async function seedAiActions(db: Db): Promise<void> {
  await db.insert(aiActions).values(BUILTIN_ACTIONS).onConflictDoNothing({ target: aiActions.id });
}
