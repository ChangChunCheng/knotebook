/**
 * Diff in hash space: a base keeps only 8-byte HMACs per line, no text. Both agent hashes use
 * that base row's salt and the shared `lineKey`/`normalizeNumbered` (a second normalization
 * would make every line look changed). On Myers overflow: unique-line anchors (patience LIS),
 * recursing between anchors; a sub-span with no anchors degrades (`degradedLines`). Global
 * work and depth caps degrade everything unprocessed. Yields by time budget at the d loop and
 * each sub-span entry, one timer shared across the recursion. Ties take the standard
 * delete-before-insert backtrack. Anchors are line pairs unique on both sides within the sub-span
 * (uniqueness recomputed per sub-span); an agent line that is a candidate for both a kind-0 and a
 * kind-1 key anchors neither. A Myers step is one diagonal per d iteration plus one per snake
 * advance (prefix/suffix stripping and anchor scans excluded).
 */
import { LINE_HASH_BYTES, hmacOf } from "./base-hash.js";
import { lineKey, normalizeNumbered } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

/** `line_hashes`: 8-byte hashes concatenated; `line_kinds`: 0 = raw, 1 = numbered. */
export interface BaseLines {
  hashes: Buffer;
  kinds: Buffer;
}
export interface AgentLines {
  raw: string[];
  num: string[];
}

export const DIFF_MAX_D = 2000;
/** Myers steps ≤ factor·(N+M)·maxD. */
export const DIFF_WORK_MAX_FACTOR = 4;
export const DIFF_DEPTH_MAX = 32;

export interface LineDiff {
  /** -1 = unpaired; pairs are strictly increasing. */
  pair: Int32Array;
  overflow: boolean;
  anchored: number;
  degradedLines: number;
  capHit?: "work" | "depth";
  maxDepthSeen: number;
  checkpoints: number;
  work: number;
}

export interface DiffOptions {
  maxD?: number;
  yieldFn?: () => Promise<void>;
  now?: () => number;
  workFactor?: number;
  maxDepth?: number;
}

const h8 = (b: Buffer): string => b.toString("latin1", 0, LINE_HASH_BYTES);

export async function hashAgentLines(
  key: Buffer,
  salt: Buffer,
  lines: string[],
  opts: { yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<AgentLines> {
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  const raw = new Array<string>(lines.length);
  const num = new Array<string>(lines.length);
  let last = now();
  for (let i = 0; i < lines.length; i++) {
    const k = lineKey(lines[i]!);
    const r = h8(hmacOf(key, salt, k));
    raw[i] = r;
    const nk = normalizeNumbered(k);
    num[i] = nk === k ? r : h8(hmacOf(key, salt, nk));
    if ((i & 63) === 63 && now() - last >= YIELD_AFTER_MS) {
      await yieldFn();
      last = now();
    }
  }
  return { raw, num };
}

interface Ctx {
  baseId: Int32Array;
  baseKind: Uint8Array;
  rawId: Int32Array;
  numId: Int32Array;
  pair: Int32Array;
  maxD: number;
  maxDepth: number;
  workCap: number;
  work: number;
  overflow: boolean;
  anchored: number;
  degradedLines: number;
  capHit?: "work" | "depth";
  maxDepthSeen: number;
  checkpoints: number;
  last: number;
  now: () => number;
  yieldFn: () => Promise<void>;
}

const eq = (c: Ctx, i: number, j: number): boolean => (c.baseKind[i] === 1 ? c.numId[j] : c.rawId[j]) === c.baseId[i];

async function checkpoint(c: Ctx): Promise<void> {
  c.checkpoints++;
  if (c.now() - c.last >= YIELD_AFTER_MS) {
    await c.yieldFn();
    c.last = c.now();
  }
}

async function myers(c: Ctx, aLo: number, n: number, bLo: number, m: number): Promise<number[] | "overflow" | "capped"> {
  const dMax = Math.min(c.maxD, n + m);
  const off = dMax + 1;
  const v = new Int32Array(2 * dMax + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= dMax; d++) {
    await checkpoint(c);
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      c.work++;
      while (x < n && y < m && eq(c, aLo + x, bLo + y)) {
        x++;
        y++;
        c.work++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, aLo, bLo);
    }
    if (c.work > c.workCap) return "capped";
  }
  return "overflow";
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number, aLo: number, bLo: number): number[] {
  const out: number[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const t = trace[d]!;
    const base = d + 1;
    const k = x - y;
    const prevK = k === -d || (k !== d && t[base + k - 1]! < t[base + k + 1]!) ? k + 1 : k - 1;
    const prevX = t[base + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(aLo + x - 1, bLo + y - 1);
      x--;
      y--;
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return out;
}

function findAnchors(c: Ctx, aLo: number, aHi: number, bLo: number, bHi: number): Array<[number, number]> {
  const baseCount = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) baseCount.set(c.baseId[i]!, (baseCount.get(c.baseId[i]!) ?? 0) + 1);
  const agentCount = new Map<number, number>();
  const agentAt = new Map<number, number>();
  const bump = (id: number, j: number) => {
    if (id < 0) return;
    agentCount.set(id, (agentCount.get(id) ?? 0) + 1);
    agentAt.set(id, j);
  };
  for (let j = bLo; j < bHi; j++) {
    bump(c.rawId[j]!, j);
    if (c.numId[j] !== c.rawId[j]) bump(c.numId[j]!, j);
  }
  const cand: Array<[number, number]> = [];
  const perAgent = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) {
    const id = c.baseId[i]!;
    if (baseCount.get(id) !== 1 || agentCount.get(id) !== 1) continue;
    const j = agentAt.get(id)!;
    cand.push([i, j]);
    perAgent.set(j, (perAgent.get(j) ?? 0) + 1);
  }
  const uniq = cand.filter(([, j]) => perAgent.get(j) === 1);
  const tails: number[] = [];
  const prev = new Int32Array(uniq.length).fill(-1);
  for (let q = 0; q < uniq.length; q++) {
    const j = uniq[q]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (uniq[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[q] = tails[lo - 1]!;
    tails[lo] = q;
  }
  const out: Array<[number, number]> = [];
  for (let q = tails.length === 0 ? -1 : tails[tails.length - 1]!; q !== -1; q = prev[q]!) out.push(uniq[q]!);
  return out.reverse();
}

function degrade(c: Ctx, n: number): void {
  c.overflow = true;
  c.degradedLines += n;
}

async function diffSpan(c: Ctx, aLo: number, aHi: number, bLo: number, bHi: number, depth: number): Promise<void> {
  while (aLo < aHi && bLo < bHi && eq(c, aLo, bLo)) c.pair[aLo++] = bLo++;
  while (aLo < aHi && bLo < bHi && eq(c, aHi - 1, bHi - 1)) c.pair[--aHi] = --bHi;
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 || m === 0) return; // One side empty: nothing to pair (not a degradation)
  if (depth > c.maxDepth) {
    c.capHit ??= "depth";
    return degrade(c, n);
  }
  if (depth > c.maxDepthSeen) c.maxDepthSeen = depth;
  if (c.work > c.workCap) {
    c.capHit ??= "work";
    return degrade(c, n);
  }
  await checkpoint(c);
  const r = await myers(c, aLo, n, bLo, m);
  if (r === "capped") {
    c.capHit ??= "work";
    return degrade(c, n);
  }
  if (r !== "overflow") {
    for (let q = 0; q < r.length; q += 2) c.pair[r[q]!] = r[q + 1]!;
    return;
  }
  c.overflow = true;
  const anchors = findAnchors(c, aLo, aHi, bLo, bHi);
  if (anchors.length === 0) return degrade(c, n);
  c.anchored += anchors.length;
  let pi = aLo;
  let pj = bLo;
  for (const [i, j] of anchors) {
    await diffSpan(c, pi, i, pj, j, depth + 1);
    c.pair[i] = j;
    pi = i + 1;
    pj = j + 1;
  }
  await diffSpan(c, pi, aHi, pj, bHi, depth + 1);
}

export async function diffLines(base: BaseLines, agent: AgentLines, opts: DiffOptions = {}): Promise<LineDiff> {
  const N = base.kinds.length;
  const M = agent.raw.length;
  if (base.hashes.length !== N * LINE_HASH_BYTES) throw new Error("diffLines: hashes and kinds differ in length");
  const ids = new Map<string, number>();
  const baseId = new Int32Array(N);
  const baseKind = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const kind = base.kinds[i] === 1 ? 1 : 0;
    baseKind[i] = kind;
    const key = kind + base.hashes.toString("latin1", i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    baseId[i] = id;
  }
  const rawId = new Int32Array(M);
  const numId = new Int32Array(M);
  for (let j = 0; j < M; j++) {
    rawId[j] = ids.get("0" + agent.raw[j]!) ?? -1;
    numId[j] = ids.get("1" + agent.num[j]!) ?? -1;
  }
  const maxD = opts.maxD ?? DIFF_MAX_D;
  const now = opts.now ?? (() => performance.now());
  const c: Ctx = {
    baseId,
    baseKind,
    rawId,
    numId,
    pair: new Int32Array(N).fill(-1),
    maxD,
    maxDepth: opts.maxDepth ?? DIFF_DEPTH_MAX,
    workCap: (opts.workFactor ?? DIFF_WORK_MAX_FACTOR) * (N + M) * maxD,
    work: 0,
    overflow: false,
    anchored: 0,
    degradedLines: 0,
    maxDepthSeen: 0,
    checkpoints: 0,
    last: now(),
    now,
    yieldFn: opts.yieldFn ?? yieldToLoop,
  };
  await diffSpan(c, 0, N, 0, M, 0);
  const out: LineDiff = {
    pair: c.pair,
    overflow: c.overflow,
    anchored: c.anchored,
    degradedLines: c.degradedLines,
    maxDepthSeen: c.maxDepthSeen,
    checkpoints: c.checkpoints,
    work: c.work,
  };
  if (c.capHit !== undefined) out.capHit = c.capHit;
  return out;
}
