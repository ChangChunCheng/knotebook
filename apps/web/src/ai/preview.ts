import type { Block, BlockNoteEditor } from "@blocknote/core";
// Type-only import: importing values would pull the `diff` package into the NotePage chunk.
import type { DiffBlock } from "@/lib/version-diff";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyBlock = Block<any, any, any>;

/** Frozen when streaming finishes, before auto-apply; never re-read from the editor. */
export interface AiPreview {
  before: DiffBlock[];
  after: DiffBlock[];
  noChange: boolean;
}

export function stripTextWrapper(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<text>") || !trimmed.endsWith("</text>")) return raw;
  return trimmed
    .slice("<text>".length, trimmed.length - "</text>".length)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
}

export function normalizeMarkdown(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

// The model returns the original text when the request is out of scope.
export function isNoChange(result: string, original: string): boolean {
  return normalizeMarkdown(result) === normalizeMarkdown(original);
}

export function buildPreview(editor: AnyEditor, blockIds: readonly string[], afterBlocks: readonly DiffBlock[], noChange: boolean): AiPreview {
  const anchorBlocks = blockIds.map((id) => editor.getBlock(id)).filter((block): block is AnyBlock => block !== undefined);
  return { before: anchorBlocks, after: [...afterBlocks], noChange };
}
