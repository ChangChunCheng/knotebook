import { diffWordsWithSpace } from "diff";
import { normalizeAnchor, wikilinkHref, wikilinkVisibleText } from "@knotebook/shared";

/**
 * Pairing is per level (a move across levels = delete + add), in three passes that each take what the previous left:
 * 1a by `id` (a pair with differing content yields if either block's content appears exactly in an unpaired block on the
 * other side and nothing on its own side can take it: pressing Enter at a block start leaves the old id on an empty block);
 * 1b identical content in order of appearance (pasting the whole note reissues every id);
 * 1c text blocks in a candidate band by highest token-bigram Dice, >= 0.5 (an empty text block has 0 tokens, so no 1c).
 * `moved` is one LIS over the pairs of all three passes.
 * Deleted blocks and their descendants get synthetic ids `diff-del-<n>`, otherwise a promoted child of a deleted parent
 * would collide with the same block on the b side. A missing or repeated id (corrupt snapshot) cannot pair: on the b side
 * it becomes an addition `diff-anon-<n>`, on the a side a deletion.
 */
export interface DiffBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DiffBlock[];
}
export type DiffStatus = "added" | "deleted" | "changed" | "unchanged";
export type DiffMark = "added" | "deleted" | "changed" | "moved" | "context" | "collapsed";
export interface DiffEntry {
  key: string;
  status: DiffStatus;
  moved: boolean;
  before: DiffBlock | null;
  after: DiffBlock | null;
  children: DiffEntry[];
}
export interface DiffMarkInfo {
  mark: DiffMark;
  moved: boolean;
  nonText: boolean;
}
export interface DiffRender {
  blocks: DiffBlock[];
  marks: Map<string, DiffMarkInfo>;
}

export const INLINE_DIFF_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
]);

interface Ctx {
  del: number;
  anon: number;
}

/** #269: ignores a wikilink's `snapshotTitle` (it often changes on an MCP / AI round trip) so blocks are not marked changed. Serialization only; the input is not rewritten. */
function ignoreWikilinkSnapshot(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "wikilink") {
    const { props, ...rest } = value as { props?: Record<string, unknown> };
    if (props && "snapshotTitle" in props) {
      const { snapshotTitle: _ignored, ...keep } = props;
      return { ...rest, props: keep };
    }
  }
  return value;
}
/**
 * Rows and columns pair by id only: they have no content, so every row's shallow form is identical, and without an id 1b
 * would pair "delete one column, add one column" as the same column. With the id in the key, 1a does not yield either.
 */
const ID_PAIRED_TYPES: ReadonlySet<string> = new Set(["columnList", "column"]);
const shallow = (b: DiffBlock) =>
  JSON.stringify({ type: b.type, props: b.props ?? {}, content: b.content ?? null, ...(ID_PAIRED_TYPES.has(b.type) ? { id: b.id ?? null } : {}) }, ignoreWikilinkSnapshot);

function lisPositions(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

function pairableIds(level: readonly DiffBlock[]): Set<string> {
  const seen = new Map<string, number>();
  for (const b of level) if (typeof b.id === "string" && b.id !== "") seen.set(b.id, (seen.get(b.id) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n === 1).map(([id]) => id));
}

function deletedSubtree(b: DiffBlock, ctx: Ctx): DiffEntry {
  ctx.del += 1;
  const key = `diff-del-${ctx.del}`;
  return { key, status: "deleted", moved: false, before: b, after: null, children: (b.children ?? []).map((c) => deletedSubtree(c, ctx)) };
}

function addedSubtree(b: DiffBlock, ctx: Ctx, pairable: boolean): DiffEntry {
  let key = b.id ?? "";
  if (!pairable) {
    ctx.anon += 1;
    key = `diff-anon-${ctx.anon}`;
  }
  const childIds = pairableIds(b.children ?? []);
  return {
    key,
    status: "added",
    moved: false,
    before: null,
    after: b,
    children: (b.children ?? []).map((c) => addedSubtree(c, ctx, typeof c.id === "string" && childIds.has(c.id))),
  };
}

export const FUZZY_WINDOW = 30;
export const FUZZY_THRESHOLD = 0.5;
/** Shorter blocks pair only by exact equality in 1b. */
export const FUZZY_MIN_TOKENS = 4;

function textOf(b: DiffBlock): string {
  return flatten(b.content)
    .map((u) => u.ch)
    .join("");
}

const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u;
const SEPARATOR = /[\s\p{P}]/u;

/**
 * A run of Latin letters/digits is one token, every other character its own. Character bigrams are too loose for English
 * (unrelated paragraphs often pass 0.5); token bigrams are word pairs for English and character pairs for CJK.
 */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  let run = "";
  for (const ch of text) {
    if (LATIN_OR_DIGIT.test(ch)) {
      run += ch;
      continue;
    }
    if (run) out.push(run);
    run = "";
    if (!SEPARATOR.test(ch)) out.push(ch);
  }
  if (run) out.push(run);
  return out;
}

function bigrams(tokens: readonly string[]): [Map<string, number>, number] {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const g = `${tokens[i]}\u0001${tokens[i + 1]}`;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return [m, Math.max(0, tokens.length - 1)];
}

/** With `floor`, returns -1 as soon as the score provably cannot reach it. */
function diceOf(x: Map<string, number>, xn: number, y: Map<string, number>, yn: number, floor = 0): number {
  if (xn + yn === 0) return 0;
  const [small, big, smallN] = x.size <= y.size ? [x, y, xn] : [y, x, yn];
  const need = (floor * (xn + yn)) / 2; // the intersection must be at least this large for the score to reach floor
  let inter = 0;
  let left = smallN; // bigrams in small not yet scanned (with repeats)
  for (const [g, n] of small) {
    inter += Math.min(n, big.get(g) ?? 0);
    left -= n;
    if (inter + left < need) return -1;
  }
  return (2 * inter) / (xn + yn);
}

/** Does not apply `FUZZY_MIN_TOKENS`; that is 1c's job. */
export function bigramDice(a: string, b: string): number {
  const [ga, na] = bigrams(tokensOf(a));
  const [gb, nb] = bigrams(tokensOf(b));
  if (na === 0 || nb === 0) return 0;
  return diceOf(ga, na, gb, nb);
}

function isBlankText(b: DiffBlock): boolean {
  return INLINE_DIFF_TYPES.has(b.type) && textOf(b) === "";
}

function pairLevel(a: readonly DiffBlock[], b: readonly DiffBlock[], aOk: Set<string>, bOk: Set<string>): Map<number, number> {
  const aCan = a.map((blk) => typeof blk.id === "string" && aOk.has(blk.id));
  const bCan = b.map((blk) => typeof blk.id === "string" && bOk.has(blk.id));
  const aKey = a.map(shallow);
  const bKey = b.map(shallow);
  const aIndexById = new Map<string, number>();
  a.forEach((blk, i) => {
    if (aCan[i]) aIndexById.set(blk.id!, i);
  });

  // The yield pool includes empty text blocks: typing in a trailing empty paragraph makes BlockNote add a new empty one;
  // the old-id one yields and the two empty paragraphs pair as unchanged via 1b, so only the new text is added.
  const aMat = aCan;
  const bMat = bCan;

  // 1a: same id and equal shallow form → fixed. Otherwise a block yields to the pool when the other side's pool holds more
  // equal items than its own side's (counts, not presence: presence would cross-pair duplicates and give a false moved).
  // Yielding enlarges the pool and can chain, so rerun in b order until nothing new yields.
  const idPairs: Array<[number, number]> = []; // [bi, ai], in b order
  b.forEach((blk, bi) => {
    if (!bCan[bi]) return;
    const ai = aIndexById.get(blk.id!);
    if (ai !== undefined) idPairs.push([bi, ai]);
  });
  const aInIdPair = new Set<number>(idPairs.map(([, ai]) => ai));
  const bInIdPair = new Set<number>(idPairs.map(([bi]) => bi));
  const aPool = new Map<string, number>(); // shallow form → count of blocks in the pool
  const bPool = new Map<string, number>();
  const bump = (pool: Map<string, number>, key: string) => pool.set(key, (pool.get(key) ?? 0) + 1);
  a.forEach((_, ai) => {
    if (aMat[ai] && !aInIdPair.has(ai)) bump(aPool, aKey[ai]);
  });
  b.forEach((_, bi) => {
    if (bMat[bi] && !bInIdPair.has(bi)) bump(bPool, bKey[bi]);
  });
  const surplus = (key: string, there: Map<string, number>, here: Map<string, number>) => (there.get(key) ?? 0) > (here.get(key) ?? 0);
  const contested = idPairs.filter(([bi, ai]) => aKey[ai] !== bKey[bi]);
  const yielded = new Set<number>(); // b indexes that yielded
  for (let grew = true; grew; ) {
    grew = false;
    for (const [bi, ai] of contested) {
      if (yielded.has(bi)) continue;
      const aWanted = aMat[ai] && surplus(aKey[ai], bPool, aPool);
      const bWanted = bMat[bi] && surplus(bKey[bi], aPool, bPool);
      if (!aWanted && !bWanted) continue;
      yielded.add(bi);
      if (aMat[ai]) bump(aPool, aKey[ai]);
      if (bMat[bi]) bump(bPool, bKey[bi]);
      grew = true;
    }
  }
  const pairs = new Map<number, number>();
  const aUsed = new Set<number>();
  for (const [bi, ai] of idPairs) {
    if (yielded.has(bi)) continue;
    pairs.set(bi, ai);
    aUsed.add(ai);
  }

  const byKey = new Map<string, number[]>();
  a.forEach((_, ai) => {
    if (!aCan[ai] || aUsed.has(ai)) return;
    const list = byKey.get(aKey[ai]);
    if (list) list.push(ai);
    else byKey.set(aKey[ai], [ai]);
  });
  const cursor = new Map<string, number>();
  b.forEach((_, bi) => {
    if (!bCan[bi] || pairs.has(bi)) return;
    const list = byKey.get(bKey[bi]);
    const k = cursor.get(bKey[bi]) ?? 0;
    if (!list || k >= list.length) return;
    cursor.set(bKey[bi], k + 1);
    pairs.set(bi, list[k]);
    aUsed.add(list[k]);
  });

  // 1c band center = (position in a's unpaired sequence of the previous 1c match) + 1. An unmatched new b block does not
  // move it, so any number of inserted blocks still match (centering on b's position would lose the whole stretch once
  // insertions minus deletions exceed the band). If more than a band's worth of consecutive a blocks fail to match, the
  // center falls behind and the rest degrades to delete + add (never a mismatch).
  type Fuzzy = { idx: number; type: string; grams: Map<string, number>; n: number };
  const fuzzyOf = (blk: DiffBlock, idx: number): Fuzzy | null => {
    if (!INLINE_DIFF_TYPES.has(blk.type)) return null;
    const tokens = tokensOf(textOf(blk));
    if (tokens.length < FUZZY_MIN_TOKENS) return null;
    const [grams, n] = bigrams(tokens);
    return { idx, type: blk.type, grams, n };
  };
  const aRest: Array<Fuzzy | null> = [];
  a.forEach((blk, ai) => {
    if (aCan[ai] && !aUsed.has(ai)) aRest.push(fuzzyOf(blk, ai));
  });
  const restTaken = new Array<boolean>(aRest.length).fill(false);
  let center = 0;
  b.forEach((blk, bi) => {
    if (!bCan[bi] || pairs.has(bi)) return;
    const fb = fuzzyOf(blk, bi);
    if (!fb) return;
    let best = -1;
    let bestScore = FUZZY_THRESHOLD;
    const hi = Math.min(aRest.length - 1, center + FUZZY_WINDOW);
    for (let r = Math.max(0, center - FUZZY_WINDOW); r <= hi; r += 1) {
      const fa = aRest[r];
      if (!fa || restTaken[r] || fa.type !== fb.type) continue;
      // 2·min/sum is an upper bound on Dice: skip if even that is below the best so far.
      if ((2 * Math.min(fa.n, fb.n)) / (fa.n + fb.n) < bestScore) continue;
      const score = diceOf(fa.grams, fa.n, fb.grams, fb.n, bestScore);
      if (best === -1 ? score >= bestScore : score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (best === -1) return;
    restTaken[best] = true;
    pairs.set(bi, aRest[best]!.idx);
    center = best + 1;
  });
  return pairs;
}

function diffLevel(a: readonly DiffBlock[], b: readonly DiffBlock[], ctx: Ctx): DiffEntry[] {
  const bOk = pairableIds(b);
  const pairs = pairLevel(a, b, pairableIds(a), bOk); // b index → a index
  const pairedA = new Map<number, number>(); // a index → b index
  for (const [bi, ai] of pairs) pairedA.set(ai, bi);

  // moved: LIS over the pairs of all three passes; pairs empty on both sides stay out and are never moved (an empty-line move is noise).
  const commonB = b.map((_, bi) => bi).filter((bi) => pairs.has(bi) && !(isBlankText(b[bi]) && isBlankText(a[pairs.get(bi)!])));
  const keep = lisPositions(commonB.map((bi) => pairs.get(bi)!));
  const moved = new Set(commonB.filter((_, i) => !keep.has(i)));

  const out: DiffEntry[] = [];
  const posOfB = new Array<number>(b.length).fill(-1); // b index → position in out
  b.forEach((blk, bi) => {
    const ai = pairs.get(bi);
    if (ai !== undefined) {
      const before = a[ai];
      out.push({
        key: blk.id!, // a paired b is always pairable (unique within b)
        status: shallow(before) === shallow(blk) ? "unchanged" : "changed",
        moved: moved.has(bi),
        before,
        after: blk,
        children: diffLevel(before.children ?? [], blk.children ?? [], ctx),
      });
    } else {
      out.push(addedSubtree(blk, ctx, typeof blk.id === "string" && bOk.has(blk.id)));
    }
    posOfB[bi] = out.length - 1;
  });

  // The anchor skips pairs that are empty on both sides with different ids (1b can pair a deleted empty line with a new one
  // arbitrarily far away, which would show the deletion far from where it was).
  let headInsert = 0;
  const afterCount = new Map<number, number>(); // anchor b index → number of deletions inserted after it so far
  for (let i = 0; i < a.length; i += 1) {
    if (pairedA.has(i)) continue;
    let anchor: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const bj = pairedA.get(j);
      if (bj !== undefined && !(isBlankText(a[j]) && isBlankText(b[bj]) && a[j].id !== b[bj].id)) {
        anchor = bj;
        break;
      }
    }
    const entry = deletedSubtree(a[i], ctx);
    let at: number;
    if (anchor === null) {
      at = headInsert;
      headInsert += 1;
    } else {
      const n = afterCount.get(anchor) ?? 0;
      at = posOfB[anchor] + 1 + n;
      afterCount.set(anchor, n + 1);
    }
    out.splice(at, 0, entry);
    for (let k = 0; k < posOfB.length; k += 1) if (posOfB[k] >= at) posOfB[k] += 1;
  }
  return out;
}

export function diffBlocks(a: readonly DiffBlock[], b: readonly DiffBlock[]): DiffEntry[] {
  return diffLevel(a, b, { del: 0, anon: 0 });
}

export function markOf(e: DiffEntry): DiffMark {
  if (e.status === "added" || e.status === "deleted" || e.status === "changed") return e.status;
  return e.moved ? "moved" : "context";
}

type Styles = Record<string, unknown>;
type Side = "eq" | "del" | "add";
interface Unit {
  ch: string;
  styles: Styles;
  href?: string;
  /** Matching key of a wikilink unit [targetNoteId, anchorBlockId, label]; excludes snapshotTitle. */
  wl?: string;
  node?: unknown;
  side?: Side;
}
const OBJ = "\uFFFC";

/** Supplied only by renderDiff's per-character level; `textOf` does not, so a wikilink stays one U+FFFC for pairing. */
type WikilinkText = (props: Record<string, unknown>) => string;

function flatten(content: unknown, wikilinkText?: WikilinkText): Unit[] {
  const units: Unit[] = [];
  if (!Array.isArray(content)) return units;
  for (const item of content as Array<Record<string, unknown>>) {
    if (item.type === "text") {
      for (const ch of Array.from(String(item.text ?? ""))) units.push({ ch, styles: (item.styles as Styles) ?? {} });
    } else if (item.type === "link") {
      for (const inner of (item.content as Array<Record<string, unknown>>) ?? []) {
        for (const ch of Array.from(String(inner.text ?? ""))) units.push({ ch, styles: (inner.styles as Styles) ?? {}, href: String(item.href) });
      }
    } else if (item.type === "wikilink" && wikilinkText) {
      const props = (item.props ?? {}) as Record<string, unknown>;
      const id = String(props.targetNoteId ?? "");
      const anchor = normalizeAnchor(props.anchorBlockId);
      const href = wikilinkHref(id, anchor);
      const wl = JSON.stringify([id, anchor, typeof props.label === "string" ? props.label : ""]);
      for (const ch of Array.from(wikilinkText(props))) units.push({ ch, styles: {}, href, wl });
    } else {
      units.push({ ch: OBJ, styles: {}, node: item });
    }
  }
  return units;
}

const unitKey = (u: Unit) => `${u.href ?? ""}\u0000${u.wl ?? ""}`;

/** A deleted wikilink and an immediately following inserted plain link with the same href must never merge. */
function regroup(units: Unit[]): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  let lastLinkKey: string | null = null;
  for (const u of units) {
    if (u.node !== undefined) {
      out.push(u.node as Record<string, unknown>);
      lastLinkKey = null;
      continue;
    }
    const text = { type: "text", text: u.ch, styles: u.styles };
    const last = out[out.length - 1];
    if (u.href !== undefined) {
      const key = `${unitKey(u)}\u0000${u.side ?? "eq"}`;
      if (last?.type === "link" && lastLinkKey === key) {
        const inner = last.content as Array<Record<string, unknown>>;
        const tail = inner[inner.length - 1]!;
        if (JSON.stringify(tail.styles) === JSON.stringify(u.styles)) tail.text = String(tail.text) + u.ch;
        else inner.push(text);
      } else {
        out.push({ type: "link", href: u.href, content: [text] });
      }
      lastLinkKey = key;
    } else if (last?.type === "text" && JSON.stringify(last.styles) === JSON.stringify(u.styles)) {
      last.text = String(last.text) + u.ch;
      lastLinkKey = null;
    } else {
      out.push(text);
      lastLinkKey = null;
    }
  }
  return out;
}

const asDeleted = (u: Unit): Unit => (u.node !== undefined ? { ...u, side: "del" } : { ...u, side: "del", styles: { ...u.styles, strike: true, backgroundColor: "red" } });
const asAdded = (u: Unit): Unit => (u.node !== undefined ? { ...u, side: "add" } : { ...u, side: "add", styles: { ...u.styles, backgroundColor: "green" } });

/** #269: each maximal non-equal region is emitted as all old-side units then all new-side units (not interleaved), so regroup rebuilds each side into one node. */
function inlineDiff(aContent: unknown, bContent: unknown, wikilinkText?: WikilinkText): unknown[] {
  const ua = flatten(aContent, wikilinkText);
  const ub = flatten(bContent, wikilinkText);
  const parts = diffWordsWithSpace(ua.map((u) => u.ch).join(""), ub.map((u) => u.ch).join(""));
  const ops: Array<{ side: Side; unit: Unit }> = [];
  let ia = 0;
  let ib = 0;
  for (const part of parts) {
    const n = Array.from(part.value).length;
    if (part.added) {
      for (const u of ub.slice(ib, ib + n)) ops.push({ side: "add", unit: u });
      ib += n;
    } else if (part.removed) {
      for (const u of ua.slice(ia, ia + n)) ops.push({ side: "del", unit: u });
      ia += n;
    } else {
      for (let k = 0; k < n; k += 1) {
        const x = ua[ia + k]!;
        const y = ub[ib + k]!;
        if (unitKey(x) === unitKey(y)) ops.push({ side: "eq", unit: y });
        else {
          ops.push({ side: "del", unit: x });
          ops.push({ side: "add", unit: y });
        }
      }
      ia += n;
      ib += n;
    }
  }
  const out: Unit[] = [];
  let dels: Unit[] = [];
  let adds: Unit[] = [];
  const flush = () => {
    out.push(...dels.map(asDeleted), ...adds.map(asAdded));
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.side === "eq") {
      flush();
      out.push(op.unit);
    } else if (op.side === "del") dels.push(op.unit);
    else adds.push(op.unit);
  }
  flush();
  return regroup(out);
}

function hasChange(e: DiffEntry): boolean {
  return markOf(e) !== "context" || e.children.some(hasChange);
}

/** No collapsing directly under `columnList`: a placeholder paragraph cannot be its direct child. */
function renderLevel(
  entries: DiffEntry[],
  marks: Map<string, DiffMarkInfo>,
  opts: { onlyChanges: boolean; collapsedText: (n: number) => string; wikilinkText: WikilinkText },
  ctx: { collapsed: number },
  parentType?: string,
): DiffBlock[] {
  const collapsible = opts.onlyChanges && parentType !== "columnList";
  const out: DiffBlock[] = [];
  let run = 0;
  const flush = () => {
    if (run === 0) return;
    ctx.collapsed += 1;
    const id = `diff-ctx-${ctx.collapsed}`;
    out.push({ id, type: "paragraph", props: {}, content: [{ type: "text", text: opts.collapsedText(run), styles: {} }], children: [] });
    marks.set(id, { mark: "collapsed", moved: false, nonText: false });
    run = 0;
  };
  for (const e of entries) {
    if (collapsible && !hasChange(e)) {
      run += 1;
      continue;
    }
    flush();
    const src = (e.status === "deleted" ? e.before : e.after)!;
    const mark = markOf(e);
    const inline = e.status === "changed" && INLINE_DIFF_TYPES.has(src.type);
    // A column-width change is visible when marked on the column itself, but the "view before/after" dialog renders a column alone and cannot show its width.
    const nonText = e.status === "changed" && !inline && !ID_PAIRED_TYPES.has(src.type);
    const content = inline ? inlineDiff(e.before!.content, e.after!.content, opts.wikilinkText) : src.content;
    out.push({ ...src, id: e.key, content, children: renderLevel(e.children, marks, opts, ctx, src.type) });
    if (mark !== "context") marks.set(e.key, { mark, moved: e.moved, nonText });
  }
  flush();
  return out;
}

export function renderDiff(
  entries: DiffEntry[],
  opts: { onlyChanges?: boolean; collapsedText?: (n: number) => string; titleOf?: (id: string) => string | undefined } = {},
): DiffRender {
  const marks = new Map<string, DiffMarkInfo>();
  const titleOf = opts.titleOf;
  const wikilinkText: WikilinkText = (props) => wikilinkVisibleText(props, titleOf?.(String(props.targetNoteId ?? "")));
  const blocks = renderLevel(
    entries,
    marks,
    { onlyChanges: opts.onlyChanges ?? false, collapsedText: opts.collapsedText ?? ((n) => `… ${n} …`), wikilinkText },
    { collapsed: 0 },
  );
  if (blocks.length === 0) return { blocks: [{ id: "diff-empty", type: "paragraph" }], marks };
  return { blocks, marks };
}

/** Keys use the original id: each side is its own editor, so there is no collision. */
export function sideBySideMarks(entries: DiffEntry[]): { left: Map<string, DiffMark>; right: Map<string, DiffMark> } {
  const left = new Map<string, DiffMark>();
  const right = new Map<string, DiffMark>();
  const walk = (es: DiffEntry[]) => {
    for (const e of es) {
      const m = markOf(e);
      if (e.status === "deleted" && e.before?.id) left.set(e.before.id, "deleted");
      if (e.status === "changed" && e.before?.id) left.set(e.before.id, "changed");
      if ((m === "added" || m === "changed" || m === "moved") && e.after?.id && !e.key.startsWith("diff-")) right.set(e.after.id, m);
      walk(e.children);
    }
  };
  walk(entries);
  return { left, right };
}

export interface SplitRow {
  left: number | null;
  right: number | null;
}

/**
 * Rows for side-by-side alignment over top-level entries (children follow their parent). Uses indexes, not ids: duplicate
 * ids would collide as `data-id` in the DOM.
 * Anchors = paired entries with `moved === false` (matched by object identity). Pairs empty on both sides (1b can pair
 * them very far apart) are a second tier: anchors only if both indexes lie strictly between adjacent anchors, otherwise a
 * far-paired empty line would claim an anchor first and demote every genuinely unchanged block after it. Non-increasing
 * pairs are demoted. Between anchors, the unaligned a and b indexes pair up row by row; the side with extras gets null opposite.
 * Invariant: left and right (ignoring null) each strictly increase; every index of a and b appears exactly once.
 */
export function splitRows(a: readonly DiffBlock[], b: readonly DiffBlock[], entries: readonly DiffEntry[]): SplitRow[] {
  const aIdx = new Map<DiffBlock, number>();
  a.forEach((blk, i) => aIdx.set(blk, i));
  const bIdx = new Map<DiffBlock, number>();
  b.forEach((blk, i) => bIdx.set(blk, i));
  const anchors: Array<[number, number]> = []; // strictly increasing in b (and in a)
  const blanks: Array<[number, number]> = [];
  let lastA = -1;
  for (const e of entries) {
    if (!e.before || !e.after || e.moved) continue;
    const ai = aIdx.get(e.before);
    const bi = bIdx.get(e.after);
    if (ai === undefined || bi === undefined) continue;
    if (isBlankText(e.before) && isBlankText(e.after)) {
      blanks.push([ai, bi]);
      continue;
    }
    if (ai <= lastA) continue; // safeguard: LIS guarantees this cannot happen; if it does, demote
    anchors.push([ai, bi]);
    lastA = ai;
  }
  for (const [ai, bi] of blanks) {
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][1] < bi) lo = mid + 1;
      else hi = mid;
    }
    const prevA = lo > 0 ? anchors[lo - 1][0] : -1;
    const nextA = lo < anchors.length ? anchors[lo][0] : a.length;
    if (prevA < ai && ai < nextA) anchors.splice(lo, 0, [ai, bi]);
  }
  const rows: SplitRow[] = [];
  let ia = 0;
  let ib = 0;
  const gap = (endA: number, endB: number) => {
    const n = Math.max(endA - ia, endB - ib);
    for (let k = 0; k < n; k += 1) {
      rows.push({ left: ia + k < endA ? ia + k : null, right: ib + k < endB ? ib + k : null });
    }
  };
  for (const [ai, bi] of anchors) {
    gap(ai, bi);
    rows.push({ left: ai, right: bi });
    ia = ai + 1;
    ib = bi + 1;
  }
  gap(a.length, b.length);
  return rows;
}
