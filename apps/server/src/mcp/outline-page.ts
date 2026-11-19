/**
 * `section_offset` is a section index, deliberately not named like `read_note_section`'s
 * `offset` (code units). Fingerprints are dropped here by default; only `edit_note`'s success
 * response passes `withFingerprints: true` (REST parity). Error responses must never carry
 * them: the view is stale and a fresh token would invite a blind retry; the flag defaults off,
 * so only a deliberate opt-in can leak fingerprints. `edit_note` puts
 * `truncated` inside `outline` and drops `nextSectionOffset` (no tool accepts that cursor).
 */
import { z } from "zod";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, truncateText } from "./limits.js";
import { OUTLINE_SECTION_ID_DESCRIPTION } from "./note-link-strings.js";

export interface OutlinePageInput {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  fingerprint: string;
}

export interface OutlineEntryForModel {
  sectionId: string;
  level: number;
  heading: string;
  /** Only present (as `true`) when truncated; `undefined` would be invisible on the wire, so `test/unit/mcp-outline-page.test.ts` asserts on the returned object. */
  headingTruncated?: true;
  chars: number;
  fingerprint?: string;
}

export const outlineEntrySchema = z.object({
  sectionId: z.string().describe(OUTLINE_SECTION_ID_DESCRIPTION),
  level: z.number().describe("Heading depth; `0` for the `_top` section."),
  heading: z.string().max(MCP_TEXT_MAX).describe("The section's heading text, cut at 200 characters as written in JSON."),
  headingTruncated: z.literal(true).optional().describe("Present only when `heading` was cut."),
  chars: z.number().describe("Characters in this section — the full length, not the cut heading."),
});

/** `.extend()` so the shared fields' limits have one definition. */
export const outlineEntryWithFingerprintSchema = outlineEntrySchema.extend({
  fingerprint: z
    .string()
    .describe("Concurrency token for this section. Pass it as `if_match` to replace or delete this section."),
});

export interface OutlinePage {
  sections: OutlineEntryForModel[];
  truncated: boolean;
  nextSectionOffset: number | null;
}

/** An offset at or past the end isn't an error: empty sections, `truncated: false`, `nextSectionOffset: null`. The boundary is `>`, not `>=`: with exactly 100 sections a further page would be empty, and `truncated: true` would cost the model a pointless call. */
export function buildOutlinePage(
  entries: readonly OutlinePageInput[],
  sectionOffset: number,
  opts: { withFingerprints?: boolean } = {}
): OutlinePage {
  const slice = entries.slice(sectionOffset, sectionOffset + MCP_PAGE_MAX);
  const truncated = entries.length > sectionOffset + slice.length;
  return {
    sections: slice.map(entry => {
      const heading = truncateText(entry.heading);
      return {
        sectionId: entry.sectionId,
        level: entry.level,
        heading: heading.text,
        ...(heading.truncated ? { headingTruncated: true as const } : {}),
        chars: entry.chars,
        ...(opts.withFingerprints ? { fingerprint: entry.fingerprint } : {}),
      };
    }),
    truncated,
    nextSectionOffset: truncated ? sectionOffset + slice.length : null,
  };
}
