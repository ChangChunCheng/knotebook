// The parsing editor is headless and never mounted: `tryParseHTMLToBlocks` only uses the schema and DOM parsing, so one editor can be reused.
import { BlockNoteEditor } from "@blocknote/core";
import { createHeadlessNoteSchema } from "@knotebook/shared";
import { trailingOpenFenceLine } from "../../transfer/regions.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { DEFAULT_PARSE_TIMEOUT_MS, type ParseLimits } from "./parse-settings.js";
import type { AskFn, DocOp } from "./doc-jobs.js";
import { parseMarkdownForNote, type ParsedMarkdown, type ParseFailure } from "./markdown.js";

export interface ParseRequest {
  owner: string;
  markdown: string;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  budget?: ParseBudget;
}
/** Bulk write-back parses a file many times (and again after a fingerprint mismatch), so a per-parse limit isn't enough: a shared per-file budget (ms, deducted per parse) caps total worker time: once spent, later parses return too-complex without a worker, and a sent parse's limit never exceeds what's left. */
export interface ParseBudget {
  remainingMs: number;
}
export const PARSE_FILE_BUDGET_FACTOR = 3;
export type ParseOutcome = ParsedMarkdown | ParseFailure;

export interface MarkdownParser {
  parse(req: ParseRequest): Promise<ParseOutcome>;
  /** Whole-file `markdownToHTML` is quadratic on inputs like repeated `*a ` (~64 s for 256 KiB). Returns the line index, null if none, or `"too_complex"` on timeout/OOM/stack overflow. */
  openFenceLine(owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex">;
  fileBudget(): ParseBudget;
  timeoutMs(): number;
  runDoc?(owner: string, op: DocOp, ask: AskFn, timeoutMs: number, queueWaitMs?: number): Promise<unknown>;
  configure?(next: Partial<ParseLimits>): void;
  close(): Promise<void>;
}

export class ParserBusyError extends Error {
  override name = "ParserBusyError";
}

export const TOO_COMPLEX: ParseFailure = { error: "unsupported_block", detail: "too_complex" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
export type ParserEditor = BlockNoteEditor<any, any, any>;

/** A global `document` must exist before calling (the worker's `installGlobals` provides it). */
export function createParserEditor(baseUrl: string): ParserEditor {
  return BlockNoteEditor.create({ schema: createHeadlessNoteSchema(baseUrl) }) as ParserEditor;
}

/** `RangeError` means too complex; other errors are bugs and rethrown (`tryParseHTMLToBlocks` errors are already mapped to `editor_internal`). */
export function runParse(editor: ParserEditor, req: Omit<ParseRequest, "owner">): ParseOutcome {
  try {
    return parseMarkdownForNote(editor, req.markdown, req.candidates, req.siteOrigin);
  } catch (err) {
    if (err instanceof RangeError) return TOO_COMPLEX;
    throw err;
  }
}

export function runOpenFenceLine(lines: readonly string[]): number | null | "too_complex" {
  try {
    return trailingOpenFenceLine(lines);
  } catch (err) {
    if (err instanceof RangeError) return "too_complex";
    throw err;
  }
}

/** Exhausted budget → don't run, return `tooComplex`. The same thread can't stop midway, so the time spent is deducted afterwards. */
function charged<T, F>(budget: ParseBudget | undefined, tooComplex: F, run: () => T): T | F {
  if (budget === undefined) return run();
  if (budget.remainingMs <= 0) return tooComplex;
  const t = performance.now();
  try {
    return run();
  } finally {
    budget.remainingMs -= performance.now() - t;
  }
}

/** Unit tests only; production runtimes use the worker pool (pinned by `test/unit/parse-pool.test.ts`). Rebuilds the editor when `rebuilds` changes (the runtime replaced its window). */
export class InlineMarkdownParser implements MarkdownParser {
  private editor: ParserEditor | null = null;
  private builtAt = -1;
  constructor(private readonly runtime: { readonly baseUrl: string; readonly rebuilds: number }) {}
  async parse(req: ParseRequest): Promise<ParseOutcome> {
    if (this.editor === null || this.builtAt !== this.runtime.rebuilds) {
      this.editor = createParserEditor(this.runtime.baseUrl);
      this.builtAt = this.runtime.rebuilds;
    }
    const editor = this.editor;
    return charged(req.budget, TOO_COMPLEX, () => runParse(editor, req));
  }
  async openFenceLine(_owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex"> {
    return charged(budget, "too_complex" as const, () => runOpenFenceLine(lines));
  }
  fileBudget(): ParseBudget {
    return { remainingMs: PARSE_FILE_BUDGET_FACTOR * DEFAULT_PARSE_TIMEOUT_MS };
  }
  timeoutMs(): number {
    return DEFAULT_PARSE_TIMEOUT_MS;
  }
  async close(): Promise<void> {}
}
