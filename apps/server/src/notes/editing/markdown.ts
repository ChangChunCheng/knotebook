import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  BLOCK_PRECHECK_MIN_CHARS,
  MAX_HTML_DEPTH,
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findParseGuardFailure,
  findStructureError,
  htmlDepth,
  isBlankParseResult,
  normalizeNoteColors,
  normalizeTableWidths,
  plainParagraphFloor,
  premergeParagraphs,
  premergedHtml,
  rebindWikilinks,
  relativizeSiteUploads,
  restoreMermaidBlocks,
  syntaxCheckRoot,
  targetFromList,
  topLevelBlockFloor,
} from "@knotebook/shared";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "unsupported_columns" | "unsupported_size" | "empty_content" | "too_many_blocks";
/** Causes beyond the error code, used only to pick HTTP file write-back messages. `too_complex` is decided by the worker pool (`parse-pool.ts`), not returned by this function. */
export type ParseDetail = "event_attr" | "editor_internal" | "unknown_block" | "dropped_element" | "unclosed_comment" | "nested_paragraph" | "too_deep" | "too_complex";
export type ParseFailure = { error: ParseError; detail?: ParseDetail };
/**
 * Elements the parser drops along with their content: rejected anywhere rather than silently removed. Detected on the DOM, so a `<script>` inside an HTML comment or escaped in code doesn't count. `<embed>` isn't listed: it parses to a file block. Single source for the selector and the prefilter.
 */
export const DROPPED_TAGS = ["script", "style", "iframe", "object", "noscript", "title", "template"] as const;
export const DROPPED_SELECTOR = DROPPED_TAGS.join(", ");
/** Prefilter: DOM elements always come from a start tag in the string, so no `<name` means no DOM is needed. */
const DROPPED_PREFILTER = new RegExp(`<(?:${DROPPED_TAGS.join("|")})\\b`, "i");
export function hasDroppedElement(html: string): boolean {
  return DROPPED_PREFILTER.test(html) && syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
}
const UNCLOSED_COMMENT = /<!--(?![\s\S]*?-->)/;

export { BLOCK_PRECHECK_MIN_CHARS, MAX_HTML_DEPTH, htmlDepth, plainParagraphFloor, premergeParagraphs, topLevelBlockFloor };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// Pure, no DB. In-site links are matched against a list prefetched before the lease; redirect/prev_slug/legacy slug forms aren't resolved and stay ordinary links.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | ParseFailure {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  type AnyPartialBlock = PartialBlock<any, any, any>;
  if (plainParagraphFloor(markdown) > MAX_BLOCKS) return { error: "too_many_blocks" };
  // No string estimate before the syntax check: it's quadratic and wrongly blocked `<T>` in code blocks; deep nesting is bounded by the worker's time and stack limits (→ `too_complex`).
  const syntax = checkNoteMarkdownSyntax(markdown, "top");
  // The shared syntax check returns unsupported_block only for event attributes.
  if (!syntax.ok) return syntax.error === "unsupported_block" ? { error: syntax.error, detail: "event_attr" } : { error: syntax.error };
  // The premerge edits the shared DOM in place, so it goes last.
  const root = syntaxCheckRoot(syntax.html);
  if (DROPPED_PREFILTER.test(syntax.html) && root.querySelector(DROPPED_SELECTOR) !== null) return { error: "unsupported_block", detail: "dropped_element" };
  const guard = findParseGuardFailure(root);
  if (guard !== null) return { error: "unsupported_block", detail: guard };
  if (markdown.length >= BLOCK_PRECHECK_MIN_CHARS && topLevelBlockFloor(root) > MAX_BLOCKS) return { error: "too_many_blocks" };
  let raw: AnyPartialBlock[];
  try {
    // BlockNote's own merge of multi-paragraph quotes is quadratic.
    const html = premergedHtml(syntax.html, root);
    raw = editor.tryParseHTMLToBlocks(html) as AnyPartialBlock[];
  } catch (err) {
    // core throws on some editor-internal forms: reject as unstorable, not 500. Log only the class and call frames, never the message (PM errors splice content into it) or the markdown. No injected logger here, so console.warn like `version-fingerprint.ts`. Drop the message lines before picking frames so message lines starting with "    at " can't leak in.
    const frames =
      err instanceof Error
        ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l))
        : [];
    const e = { name: err instanceof Error ? err.name : typeof err, frames };
    console.warn("parseMarkdownForNote: core parse threw; rejected as unsupported_block", e);
    return { error: "unsupported_block", detail: "editor_internal" };
  }
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block", detail: "unknown_block" };
  const shape = findStructureError(parsed, "top");
  if (shape !== null) return { error: shape };
  // Also normalizes colors in place to lowercase #rrggbb.
  if (normalizeNoteColors(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) {
    return UNCLOSED_COMMENT.test(markdown) ? { error: "empty_content", detail: "unclosed_comment" } : { error: "empty_content" };
  }
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound };
}
