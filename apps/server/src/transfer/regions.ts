/**
 * Region detection is one round, no iteration: merging a segment doesn't change its
 * neighbours' adjacent lines. A segment whose adjoining text doesn't parse like it alone
 * merges into the region (`makeBoundaryCheck`). Empty-paragraph segments skip the boundary
 * check (decided by blank lines, not by type). Region text that is blank after stripping
 * closed comments drops an insert and turns a rewrite into a delete. Whether text that
 * parses to `empty_content` still has text after stripping needs a parse: `sync-plan.ts`.
 * A body blank (also after stripping closed comments) is `empty_content`. A boundary check fires
 * when the adjacent agent line exists, is non-blank and isn't the pair of the base's adjacent
 * line; the adjoining text runs out to a blank line.
 */
import { markdownToHTML, type PartialBlock } from "@blocknote/core";
import type { TransferSegment } from "../db/schema.js";
import type { LineDiff } from "./line-diff.js";
import { lineKey } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

export type BoundarySide = "before" | "after";
/** true = the boundary holds (not merged). A parse failure must return false. */
export type CheckBoundary = (kText: string, adjText: string, side: BoundarySide) => Promise<boolean>;

export interface Region {
  kind: "rewrite" | "delete" | "insert";
  segIdx: number[];
  baseIds: string[];
  baseFps: string[];
  text: string;
  /** Nearest unchanged segment before/after; -1 if none. */
  prevSeg: number;
  nextSeg: number;
}
export type RegionsResult = { ok: true; regions: Region[]; boundaryChecks: number } | { ok: false; code: "empty_content" } | { ok: false; code: "unclosed_fence"; fence: string } | { ok: false; code: "too_complex" };
/** Runs in the parse worker: `markdownToHTML` is quadratic on inputs like repeated `*a ` (about a minute for 256 KiB). */
export type OpenFenceLine = (lines: readonly string[]) => Promise<number | null | "too_complex">;

export const unclosedFenceMessage = (fence: string): string =>
  `A line you added or changed opens a code block with ${fence} that is never closed, so everything from that line to the end of the file counts as code. Add a closing ${fence} (or use inline \`code\`) and send the file again.`;
export const UNCLOSED_FENCE_MESSAGE = unclosedFenceMessage("```");

const FENCE_SENTINEL = "kn-fence-sentinel-3f9c2a7e";
const FENCE_LIKE = /^\s*(`{3,}|~{3,})/;
export const fenceParseStats = { calls: 0 };
const NL = "\n";
const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/**
 * Appends a sentinel after a blank line: if the HTML ends in `<pre><code>…sentinel</code></pre>`
 * a code block runs to the end of the file unclosed. If the computed opening line doesn't
 * look like a fence the position is uncertain, so pass (known-limitations).
 */
export function trailingOpenFenceLine(lines: readonly string[]): number | null {
  fenceParseStats.calls++;
  const html = markdownToHTML(lines.join(NL) + NL + NL + FENCE_SENTINEL);
  const at = html.lastIndexOf("<pre><code");
  if (at === -1) return null;
  const m = /^<pre><code[^>]*>([\s\S]*)<\/code><\/pre>\s*$/.exec(html.slice(at));
  if (m === null) return null;
  const parts = unescapeHtml(m[1]!).split(NL);
  if (parts[parts.length - 1] !== FENCE_SENTINEL) return null;
  const line = lines.length - 1 - (parts.length - 2);
  if (line < 0 || !FENCE_LIKE.test(lines[line]!)) return null;
  return line;
}

export function stripClosedComments(s: string): string {
  // Linear: a regex scanned to the end of the file for every unclosed `<!--` (tens of thousands of them stalled the main thread). Once a `<!--` has no `-->` after it, no later one does.
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("<!--", i);
    if (a === -1) break;
    const b = s.indexOf("-->", a + 4);
    if (b === -1) break;
    out += s.slice(i, a);
    i = b + 3;
  }
  return i === 0 ? s : out + s.slice(i);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic type parameters; repo convention (as in notes/editing/session.ts)
type AnyPartialBlock = PartialBlock<any, any, any>;

function comparable(b: unknown): unknown {
  if (Array.isArray(b)) return b.map(comparable);
  if (b === null || typeof b !== "object") return b;
  const o = b as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    if (k === "id") continue;
    if (k === "props" && o.type === "numberedListItem" && o.props !== null && typeof o.props === "object") {
      const { start: _s, ...rest } = o.props as Record<string, unknown>;
      out.props = comparable(rest);
      continue;
    }
    out[k] = comparable(o[k]);
  }
  return out;
}

/** Compares parse(k + adjoining text) with parse(k), taking parse(k)'s block count (a flattened 1-id segment parses into 2 blocks), taking from the start when the text follows, from the end when it precedes, and comparing without `id` and numbered `start`; any parse failure → false. `parse` returning null = failure. */
export function makeBoundaryCheck(parse: (markdown: string) => AnyPartialBlock[] | null | Promise<AnyPartialBlock[] | null>): CheckBoundary {
  return async (kText, adjText, side) => {
    const k = await parse(kText);
    if (k === null || k.length === 0) return false;
    const joined = await parse(side === "before" ? `${adjText}\n${kText}` : `${kText}\n${adjText}`);
    if (joined === null) return false;
    const n = k.length;
    if (joined.length < n) return false;
    const picked = side === "before" ? joined.slice(joined.length - n) : joined.slice(0, n);
    return JSON.stringify(comparable(picked)) === JSON.stringify(comparable(k));
  };
}

const blank = (l: string | undefined): boolean => l === undefined || lineKey(l) === "";
export const BOUNDARY_ADJ_MAX_CHARS = 4 * 1024;

/**
 * An added or changed line that opens a code fence running to the end of the file is a 400
 * (like an unclosed `<!--`): a whole-file parse would swallow the rest, but regions are
 * detected per region. An opening line inside an unchanged segment passes: an early exporter
 * didn't escape a paragraph that is literally ```, and re-sending the original file must not be
 * rejected. Decided with the real parser rather than hand-written fence rules.
 */
export async function findRegions(
  segments: TransferSegment[],
  baseLineCount: number,
  agentLines: string[],
  diff: LineDiff,
  checkBoundary: CheckBoundary,
  openFenceLine: OpenFenceLine,
  opts: { yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<RegionsResult> {
  const joined = agentLines.join("\n");
  if (joined.trim() === "" || stripClosedComments(joined).trim() === "") return { ok: false, code: "empty_content" };
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  let last = now();
  const pair = diff.pair;
  const M = agentLines.length;
  const S = segments.length;

  const matched = new Array<boolean>(S).fill(false);
  const emptyPara = new Array<boolean>(S).fill(false);
  for (let k = 0; k < S; k++) {
    const s = segments[k]!;
    if (s.count === 0) {
      matched[k] = true;
      emptyPara[k] = true;
      continue;
    }
    const p0 = pair[s.start]!;
    let ok = p0 !== -1;
    for (let t = 1; ok && t < s.count; t++) ok = pair[s.start + t] === p0 + t;
    matched[k] = ok;
    if (ok) {
      let allBlank = true;
      for (let t = 0; allBlank && t < s.count; t++) allBlank = lineKey(agentLines[p0 + t]!) === "";
      emptyPara[k] = allBlank;
    }
  }

  const unchanged = matched.slice();
  let boundaryChecks = 0;
  // The adjoining run's extent is computed once (linear). A run over `BOUNDARY_ADJ_MAX_CHARS` isn't parsed and counts as changed, else each segment would parse the whole run (hours of worker time); the cost is only that the segment is rewritten with a new id.
  const isBlank = new Uint8Array(M);
  for (let j = 0; j < M; j++) isBlank[j] = blank(agentLines[j]) ? 1 : 0;
  const runStart = new Int32Array(M);
  const runEnd = new Int32Array(M);
  const offset = new Float64Array(M + 1); // offset[j] = start of line j within `agentLines.join("\n")`
  for (let j = 0; j < M; j++) {
    offset[j + 1] = offset[j]! + agentLines[j]!.length + 1;
    runStart[j] = isBlank[j] ? -1 : j > 0 && !isBlank[j - 1] ? runStart[j - 1]! : j;
  }
  for (let j = M - 1; j >= 0; j--) runEnd[j] = isBlank[j] ? -1 : j + 1 < M && !isBlank[j + 1] ? runEnd[j + 1]! : j;
  const chars = (p: number, q: number) => offset[q + 1]! - offset[p]! - 1;
  const adjUp = (from: number): string | null => (chars(runStart[from]!, from) > BOUNDARY_ADJ_MAX_CHARS ? null : agentLines.slice(runStart[from]!, from + 1).join("\n"));
  const adjDown = (from: number): string | null => (chars(from, runEnd[from]!) > BOUNDARY_ADJ_MAX_CHARS ? null : agentLines.slice(from, runEnd[from]! + 1).join("\n"));
  for (let k = 0; k < S; k++) {
    if (!matched[k] || emptyPara[k]) continue;
    const s = segments[k]!;
    const a0 = pair[s.start]!;
    const a1 = a0 + s.count - 1;
    const kText = agentLines.slice(a0, a1 + 1).join("\n");
    let ok = true;
    if (a0 - 1 >= 0 && !blank(agentLines[a0 - 1]) && !(s.start - 1 >= 0 && pair[s.start - 1] === a0 - 1)) {
      boundaryChecks++;
      const adj = adjUp(a0 - 1);
      ok = adj !== null && (await checkBoundary(kText, adj, "before"));
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    }
    if (ok && a1 + 1 < M && !blank(agentLines[a1 + 1]) && !(s.start + s.count < baseLineCount && pair[s.start + s.count] === a1 + 1)) {
      boundaryChecks++;
      const adj = adjDown(a1 + 1);
      ok = adj !== null && (await checkBoundary(kText, adj, "after"));
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    }
    unchanged[k] = ok;
  }

  let seenLines = false;
  const span = segments.map(s => {
    if (s.count > 0) {
      seenLines = true;
      const a0 = pair[s.start]!;
      return { a0, a1: a0 + s.count - 1 };
    }
    return seenLines ? { a0: M, a1: M - 1 } : { a0: 0, a1: -1 };
  });

  // Exact pre-filter: if no line outside unchanged segments looks like a fence opening, skip the parser (quadratic on interleavings like `*a _b`); exact because the line `trailingOpenFenceLine` returns always matches `FENCE_LIKE`.
  const inUnchanged = new Uint8Array(M);
  for (let k = 0; k < S; k++) {
    if (!unchanged[k] || segments[k]!.count === 0) continue;
    for (let j = span[k]!.a0; j <= span[k]!.a1; j++) inUnchanged[j] = 1;
  }
  if (agentLines.some((l, j) => inUnchanged[j] === 0 && FENCE_LIKE.test(l))) {
    const open = await openFenceLine(agentLines);
    if (open === "too_complex") return { ok: false, code: "too_complex" };
    if (now() - last >= YIELD_AFTER_MS) {
      await yieldFn();
      last = now();
    }
    if (open !== null && inUnchanged[open] === 0) return { ok: false, code: "unclosed_fence", fence: FENCE_LIKE.exec(agentLines[open]!)![1]! };
  }

  const regions: Region[] = [];
  const emit = (prevSeg: number, nextSeg: number, segIdx: number[]) => {
    const lo = prevSeg === -1 ? 0 : span[prevSeg]!.a1 + 1;
    const hi = nextSeg === -1 ? M - 1 : span[nextSeg]!.a0 - 1;
    let a = lo;
    let b = hi;
    while (a <= b && blank(agentLines[a])) a++;
    while (b >= a && blank(agentLines[b])) b--;
    let text = a <= b ? agentLines.slice(a, b + 1).join("\n") : "";
    if (segIdx.length === 0 && text === "") return;
    if (text !== "" && stripClosedComments(text).trim() === "") {
      if (segIdx.length === 0) return; // An insert with only comments left: not a region
      text = ""; // A rewrite with only comments left: becomes a delete region
    }
    const baseIds = segIdx.flatMap(k => segments[k]!.ids);
    const baseFps = segIdx.flatMap(k => segments[k]!.fps);
    regions.push({ kind: segIdx.length === 0 ? "insert" : text === "" ? "delete" : "rewrite", segIdx, baseIds, baseFps, text, prevSeg, nextSeg });
  };
  let prev = -1;
  let run: number[] = [];
  for (let k = 0; k < S; k++) {
    if (!unchanged[k]) {
      run.push(k);
      continue;
    }
    emit(prev, k, run);
    prev = k;
    run = [];
  }
  emit(prev, -1, run);
  return { ok: true, regions, boundaryChecks };
}
