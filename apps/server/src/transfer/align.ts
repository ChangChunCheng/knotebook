/**
 * Explicit stack, no recursion and no spread concatenation: the recursive version blows the
 * stack at about 5 000 blocks and `[seg, ...rest]` is O(n²) (the UI can save notes beyond `MAX_BLOCKS`).
 * Groups are tried only when per-block can't complete a solution from that start, at most
 * `cap` group exports per start. Failures are memoized per `(i, pos)`; the first complete
 * solution by priority wins; none → `segs: null` (not writable back). Numbered items compare
 * without their number, and child lines may be indented `delta` more on the whole-note side.
 * Leading/trailing empty paragraphs are 0-line segments; a middle one takes one blank line.
 * Per block before groups; 1 separator line before 0. Groups take the longest same-family run
 * first (export of `(i, j)` cached). `MAX_BLOCKS` only limits writes.
 */
import { lineKey } from "./normalize.js";

export const GROUP_EXPORT_CAP = 32;

export type ListFamily = "num" | "star" | null;

export function listFamily(type: string): ListFamily {
  if (type === "numberedListItem") return "num";
  if (type === "bulletListItem" || type === "checkListItem" || type === "toggleListItem") return "star";
  return null;
}

export interface AlignSeg {
  idx: number[];
  start: number;
  count: number;
}
export interface AlignStats {
  groupCalls: number;
  capHits: number;
  groupUsedWhilePerMatched: number;
}

const TABLE_ROW = /^\s*\|/;
/** Table rows also collapse cell padding and separator `-` counts: inline color placeholders make column widths differ between whole-note and per-block export. */
function matchKey(line: string): string {
  const k = lineKey(line);
  return TABLE_ROW.test(k) ? k.replace(/ *\| */g, "|").replace(/-{3,}/g, "---") : k;
}

const NUM_PREFIX = /^(\d+)\. /;

function matchAt(W: readonly string[], pos: number, per: readonly string[], numbered: boolean): number {
  if (pos + per.length > W.length) return -1;
  let delta = 0;
  for (let k = 0; k < per.length; k++) {
    let w = W[pos + k]!;
    let p = per[k]!;
    if (k === 0 && numbered) {
      const mw = NUM_PREFIX.exec(w);
      const mp = NUM_PREFIX.exec(p);
      if (mw && mp) {
        delta = mw[0].length - mp[0].length;
        w = w.slice(mw[0].length);
        p = p.slice(mp[0].length);
      }
    } else if (k > 0 && delta !== 0 && p !== "" && w === " ".repeat(Math.max(delta, 0)) + p) {
      continue;
    }
    if (w !== p) return -1;
  }
  return per.length;
}

interface Frame {
  i: number;
  pos: number;
  stage: 0 | 1 | 2 | 3;
  sepK: number;
  j: number;
  jMax: number;
  group: string[] | null;
  perMatched: boolean;
  seg: AlignSeg | null;
  segIsGroup: boolean;
}

export function alignSegments(
  W: string[],
  P: string[][],
  types: string[],
  groupExport: (i: number, j: number) => string[],
  cap: number = GROUP_EXPORT_CAP,
): { segs: AlignSeg[] | null; stats: AlignStats } {
  const stats: AlignStats = { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0 };
  const n = types.length;
  if (P.length !== n) throw new Error("alignSegments: P and types differ in length");
  if (n === 0) return { segs: W.length === 0 ? [] : null, stats };

  const Wk = W.map(matchKey);
  const Wblank = Wk.map(l => l === "");
  const Pk = P.map(lines => lines.map(matchKey));
  const fams = types.map(listFamily);
  let firstNon = -1;
  let lastNon = -1;
  for (let i = 0; i < n; i++) {
    if (P[i]!.length > 0) {
      if (firstNon === -1) firstNon = i;
      lastNon = i;
    }
  }
  const isEdgeEmpty = (i: number) => P[i]!.length === 0 && (firstNon === -1 || i < firstNon || i > lastNon);

  const stride = W.length + 1;
  const failed = new Set<number>();
  const groupCount = new Map<number, number>();
  const groupCache = new Map<number, string[]>();
  const getGroup = (i: number, j: number): string[] | null => {
    const key = i * (n + 1) + j;
    const hit = groupCache.get(key);
    if (hit !== undefined) return hit;
    const c = groupCount.get(i) ?? 0;
    if (c >= cap) {
      stats.capHits++;
      return null;
    }
    groupCount.set(i, c + 1);
    stats.groupCalls++;
    const lines = groupExport(i, j).map(matchKey);
    groupCache.set(key, lines);
    return lines;
  };
  const blanks = (pos: number, sep: number) => {
    for (let k = 0; k < sep; k++) if (pos + k >= W.length || !Wblank[pos + k]) return false;
    return true;
  };

  const newFrame = (i: number, pos: number): Frame => {
    let jMax = i;
    const fam = fams[i]!;
    if (P[i]!.length > 0 && fam !== null) while (jMax + 1 < n && fams[jMax + 1] === fam) jMax++;
    return { i, pos, stage: isEdgeEmpty(i) ? 0 : 1, sepK: 0, j: jMax, jMax, group: null, perMatched: false, seg: null, segIsGroup: false };
  };

  const nextChild = (f: Frame): [number, number] | null => {
    const seps = f.pos === 0 ? 1 : 2; // pos 0: try only 0 separator lines; otherwise 1 first, then 0
    const sepAt = (k: number) => (f.pos === 0 ? 0 : k === 0 ? 1 : 0);
    if (f.stage === 0) {
      f.stage = 3;
      f.seg = { idx: [f.i], start: f.pos, count: 0 };
      f.segIsGroup = false;
      return [f.i + 1, f.pos];
    }
    if (f.stage === 1) {
      const per = Pk[f.i]!;
      while (f.sepK < seps) {
        const sep = sepAt(f.sepK++);
        if (!blanks(f.pos, sep)) continue;
        const p = f.pos + sep;
        if (per.length === 0) {
          if (p < W.length && Wblank[p]) {
            f.perMatched = true;
            f.seg = { idx: [f.i], start: p, count: 1 };
            f.segIsGroup = false;
            return [f.i + 1, p + 1];
          }
          continue;
        }
        const c = matchAt(Wk, p, per, types[f.i] === "numberedListItem");
        if (c >= 0) {
          f.perMatched = true;
          f.seg = { idx: [f.i], start: p, count: c };
          f.segIsGroup = false;
          return [f.i + 1, p + c];
        }
      }
      f.stage = 2;
      f.sepK = 0;
      f.j = f.jMax;
      f.group = null;
    }
    if (f.stage === 2) {
      while (f.j > f.i) {
        if (f.group === null) {
          const g = getGroup(f.i, f.j);
          if (g === null) {
            f.j = f.i; // Over the cap: abandon all groups for this start
            break;
          }
          f.group = g;
          f.sepK = 0;
        }
        while (f.sepK < seps) {
          const sep = sepAt(f.sepK++);
          if (!blanks(f.pos, sep)) continue;
          const p = f.pos + sep;
          const c = matchAt(Wk, p, f.group, false);
          if (c >= 0) {
            const idx: number[] = [];
            for (let k = f.i; k <= f.j; k++) idx.push(k);
            f.seg = { idx, start: p, count: c };
            f.segIsGroup = true;
            return [f.j + 1, p + c];
          }
        }
        f.j--;
        f.group = null;
      }
      f.stage = 3;
    }
    return null;
  };

  const stack: Frame[] = [];
  const enter = (i: number, pos: number): boolean | null => {
    if (i === n) return pos === W.length;
    if (failed.has(i * stride + pos)) return false;
    stack.push(newFrame(i, pos));
    return null;
  };

  let done = enter(0, 0);
  while (done !== true && stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const child = nextChild(top);
    if (child === null) {
      failed.add(top.i * stride + top.pos);
      stack.pop();
      continue;
    }
    done = enter(child[0], child[1]);
  }
  if (done !== true) return { segs: null, stats };

  const segs: AlignSeg[] = new Array(stack.length);
  for (let k = 0; k < stack.length; k++) {
    const f = stack[k]!;
    segs[k] = f.seg!;
    if (f.segIsGroup && f.perMatched) stats.groupUsedWhilePerMatched++;
  }
  return { segs, stats };
}

export function lineKindsOf(segs: AlignSeg[] | null, types: string[], nLines: number): number[] {
  const kinds = new Array<number>(nLines).fill(0);
  if (segs === null) return kinds;
  for (const s of segs) {
    if (!s.idx.some(i => types[i] === "numberedListItem")) continue;
    for (let k = s.start; k < s.start + s.count; k++) kinds[k] = 1;
  }
  return kinds;
}
