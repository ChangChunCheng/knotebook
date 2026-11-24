import { alignBlocks, alignInlineText, alignItemOf, type AlignSource } from "./block-align.js";
import {
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_ID_RE,
  KNOWLEDGE_WHEN_MAX,
  formatKnowledgeRef,
  generateKnowledgeId,
  isKnowledgeDate,
  knowledgeStateOf,
  knowledgeTextLength,
  parseKnowledgeRef,
  parseKnowledgeStatusInput,
  readKnowledgeInfo,
  type KnowledgeInfo,
  type KnowledgeStatus,
} from "./knowledge.js";
import { isKnowledgeFieldEnabled, knowledgeOption, type KnowledgeBuiltinFieldKey, type KnowledgeFieldView } from "./knowledge-fields.js";
import { KNOWLEDGE_PENDING_ID_PREFIX } from "./knowledge-html.js";
import { knowledgeHeadingText } from "./knowledge-list.js";
import type { KnowledgeIgnoreReason, KnowledgeIgnoredItem, KnowledgeProblem } from "./knowledge-markdown.js";
import { KNOWLEDGE_PROP_NAMES, type KnowledgePropName } from "./knowledge-schema.js";

export interface KnowledgeHeadingRef {
  id: string;
  heading: string;
}

/** A heading that wrote an id another heading holds: it got a new id; `from` is the id it wrote. */
export interface KnowledgeRenewedRef extends KnowledgeHeadingRef {
  from: string;
}

export interface KnowledgeBlockShape {
  id?: string;
  type: string;
  props?: Readonly<Record<string, unknown>>;
  content?: unknown;
  children?: readonly unknown[];
}

const asAlign = (blocks: readonly KnowledgeBlockShape[]): AlignSource[] => blocks as unknown as AlignSource[];
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isPending = (id: string): boolean => id.startsWith(KNOWLEDGE_PENDING_ID_PREFIX);
const knowledgeIdOf = (b: KnowledgeBlockShape): string => (b.type === "heading" ? str(b.props?.knowledgeId) : "");
const hasKnowledgeProps = (b: KnowledgeBlockShape): boolean => KNOWLEDGE_PROP_NAMES.some(n => str(b.props?.[n]) !== "");
const withProps = <B extends KnowledgeBlockShape>(b: B, patch: Partial<Record<KnowledgePropName, string>>): B => ({ ...b, props: { ...b.props, ...patch } });

// Blocks written as plain strings (tests, MCP input) have no inline array.
const textOf = (content: unknown): string => (typeof content === "string" ? content : alignInlineText(content)).trim();

const headingKey = (b: KnowledgeBlockShape): string | null => (b.type === "heading" ? `${String(b.props?.level)}:${textOf(b.content)}` : null);

/** `alignBlocks` pairs by order, so a swapped pair would lose one side: leftovers are then paired by level and text, but only where that key is unique in both lists. The level is not part of the alignment key, so a heading moved to another level would otherwise pair. */
export function knowledgePairs(before: readonly KnowledgeBlockShape[], after: readonly KnowledgeBlockShape[]): Array<[number, number]> {
  const pairs = alignBlocks(asAlign(before).map(alignItemOf), asAlign(after).map(alignItemOf)).filter(([o, n]) => {
    const a = before[o]!;
    const b = after[n]!;
    return a.type === "heading" && b.type === "heading" && a.props?.level === b.props?.level && textOf(a.content) === textOf(b.content);
  });
  const indexByKey = (blocks: readonly KnowledgeBlockShape[]): Map<string, number | null> => {
    const m = new Map<string, number | null>();
    blocks.forEach((b, i) => {
      const key = headingKey(b);
      if (key !== null) m.set(key, m.has(key) ? null : i);
    });
    return m;
  };
  const oldByKey = indexByKey(before);
  const newByKey = indexByKey(after);
  const oldPaired = new Set(pairs.map(([o]) => o));
  const newPaired = new Set(pairs.map(([, n]) => n));
  for (const [key, o] of oldByKey) {
    const n = newByKey.get(key);
    if (o === null || o === undefined || n === null || n === undefined || oldPaired.has(o) || newPaired.has(n)) continue;
    pairs.push([o, n]);
  }
  return pairs.sort((x, y) => x[0] - y[0]);
}

/**
 * keep=true (agent and AI rewrites): a paired heading without a comment gets the old seven props. Always: a pending id takes
 * the paired old id, else a new one. A comment that writes out an id in full is the author's decision and is never overwritten, but
 * it does not take the id from the heading that holds it: the holder is the heading that got the old id through pairing, else the one
 * paired with the old heading that had it, else the first. Every other heading that wrote it gets a new id, listed in `renewed`.
 * A repeat of an id taken outside the replaced range is left for the caller: the outside heading keeps it. Copy-on-write.
 */
export function resolveKnowledgeForWrite<B extends KnowledgeBlockShape>(input: {
  before: readonly KnowledgeBlockShape[];
  after: readonly B[];
  keep: boolean;
  taken: ReadonlySet<string>;
}): { blocks: B[]; kept: KnowledgeHeadingRef[]; created: KnowledgeHeadingRef[]; renewed: KnowledgeRenewedRef[] } {
  const { before, after, keep } = input;
  const taken = new Set(input.taken);
  for (const b of after) {
    const id = knowledgeIdOf(b);
    if (id !== "" && !isPending(id)) taken.add(id);
  }
  const blocks = [...after];
  const kept: KnowledgeHeadingRef[] = [];
  const holders = new Map<string, number>();
  const heldIndexes = new Set<number>();
  const pairedOldId = new Map<number, string>();
  // Pairing runs the block alignment, which a note without knowledge never needs.
  const pairs = before.some(b => knowledgeIdOf(b) !== "") ? knowledgePairs(before, after) : [];
  for (const [o, n] of pairs) {
    const old = before[o]!;
    const oldInfo = readKnowledgeInfo(old.props);
    if (oldInfo === null) continue;
    const next = blocks[n]!;
    const id = knowledgeIdOf(next);
    pairedOldId.set(n, oldInfo.id);
    if (id === "" && !hasKnowledgeProps(next)) {
      if (!keep) continue;
      blocks[n] = withProps(next, Object.fromEntries(KNOWLEDGE_PROP_NAMES.map(name => [name, str(old.props?.[name])])));
      kept.push({ id: oldInfo.id, heading: knowledgeHeadingText(next.content) });
    } else if (isPending(id)) {
      blocks[n] = withProps(next, { knowledgeId: oldInfo.id });
    } else continue;
    taken.add(oldInfo.id);
    if (!holders.has(oldInfo.id)) holders.set(oldInfo.id, n);
    heldIndexes.add(n);
  }
  const written = new Map<string, number[]>();
  blocks.forEach((b, i) => {
    const id = knowledgeIdOf(b);
    if (id === "" || isPending(id) || heldIndexes.has(i)) return;
    const list = written.get(id);
    if (list) list.push(i);
    else written.set(id, [i]);
  });
  const renewed: KnowledgeRenewedRef[] = [];
  for (const [id, indexes] of written) {
    const holder = holders.get(id);
    if (holder === undefined && indexes.length < 2) continue;
    const keeper = holder !== undefined ? -1 : (indexes.find(i => pairedOldId.get(i) === id) ?? indexes[0]!);
    for (const i of indexes) {
      if (i === keeper) continue;
      const fresh = generateKnowledgeId(taken);
      taken.add(fresh);
      blocks[i] = withProps(blocks[i]!, { knowledgeId: fresh });
      renewed.push({ id: fresh, heading: knowledgeHeadingText(blocks[i]!.content), from: id });
    }
  }
  const created: KnowledgeHeadingRef[] = [];
  blocks.forEach((b, i) => {
    if (!isPending(knowledgeIdOf(b))) return;
    const id = generateKnowledgeId(taken);
    taken.add(id);
    blocks[i] = withProps(b, { knowledgeId: id });
    created.push({ id, heading: knowledgeHeadingText(b.content) });
  });
  return { blocks, kept, created, renewed };
}

/** A reference to a knowledge in this very note is stored as the bare id, so it stays right when the note is copied. Copy-on-write. */
export function normalizeKnowledgeRefs<B extends KnowledgeBlockShape>(after: readonly B[], noteId: string): B[] {
  return after.map(b => {
    const value = str(b.type === "heading" ? b.props?.knowledgeSupersededBy : "");
    if (value === "") return b;
    const ref = parseKnowledgeRef(value);
    if (ref === null || ref.noteId === null || ref.noteId !== noteId.toLowerCase()) return b;
    return withProps(b, { knowledgeSupersededBy: formatKnowledgeRef(ref, noteId) });
  });
}

const LINE_BREAK = /[\r\n\u{85}\u{2028}\u{2029}]/u;

type BuiltinValue = Exclude<keyof KnowledgeInfo, "id" | "status">;
const BUILTIN: ReadonlyArray<{ key: KnowledgeBuiltinFieldKey; prop: KnowledgePropName; info: BuiltinValue }> = [
  { key: "when", prop: "knowledgeWhen", info: "when" },
  { key: "conclusion", prop: "knowledgeConclusion", info: "conclusion" },
  { key: "evidence", prop: "knowledgeEvidence", info: "evidence" },
  { key: "verified", prop: "knowledgeVerified", info: "verified" },
  { key: "superseded_by", prop: "knowledgeSupersededBy", info: "supersededBy" },
];

const asWritten = (key: KnowledgeBuiltinFieldKey, raw: string): string => (key === "evidence" && raw === "unconfirmed" ? "" : raw);

function builtinValueProblem(key: KnowledgeBuiltinFieldKey, value: string, fields: KnowledgeFieldView, id: string, noteId: string | null): KnowledgeIgnoreReason | null {
  switch (key) {
    case "when":
    case "conclusion":
      if (LINE_BREAK.test(value)) return "line_break";
      return knowledgeTextLength(value) > (key === "when" ? KNOWLEDGE_WHEN_MAX : KNOWLEDGE_CONCLUSION_MAX) ? "too_long" : null;
    case "evidence":
      return value === "" || knowledgeOption(fields, "evidence", value)?.enabled === true ? null : "not_an_option";
    case "verified":
      return value === "" || isKnowledgeDate(value) ? null : "bad_date";
    case "superseded_by": {
      if (value === "") return null;
      const ref = parseKnowledgeRef(value);
      if (ref === null) return "bad_ref";
      const own = ref.noteId === null || (noteId !== null && ref.noteId === noteId.toLowerCase());
      return own && ref.knowledgeId === id ? "superseded_self" : null;
    }
  }
}

const sameState = (a: KnowledgeStatus, b: KnowledgeStatus, verified: string): boolean => knowledgeStateOf({ status: a, verified }) === knowledgeStateOf({ status: b, verified });

function readsAsStored(stored: KnowledgeInfo, fields: KnowledgeFieldView, rawOf: (prop: KnowledgePropName) => string): boolean {
  if (!BUILTIN.every(f => !isKnowledgeFieldEnabled(fields, f.key) || asWritten(f.key, rawOf(f.prop)) === stored[f.info])) return false;
  const written = rawOf("knowledgeStatus");
  if (written === stored.status) return true;
  const parsed = parseKnowledgeStatusInput(written);
  // Every field matched, so the verified date in effect is the stored one.
  return parsed !== null && sameState(parsed, stored.status, stored.verified);
}

function patched<B extends KnowledgeBlockShape>(b: B, values: Partial<Record<KnowledgePropName, string>>): B {
  const changed = (Object.keys(values) as KnowledgePropName[]).some(name => b.props?.[name] !== values[name]);
  return changed ? withProps(b, values) : b;
}

/**
 * Run after resolveKnowledgeForWrite and normalizeKnowledgeRefs. Copy-on-write. A value that fails its check, or sits in a
 * turned-off field, is not written: the stored one stays (empty for new knowledge) and the value is listed in `ignored`.
 * A heading whose id is stored with every field reading the same is taken as stored without any check, so what is already
 * stored can always be written back. Only a malformed id refuses the whole write.
 */
export function sanitizeKnowledgeForWrite<B extends KnowledgeBlockShape>(input: {
  after: readonly B[];
  current: ReadonlyMap<string, KnowledgeInfo>;
  noteId: string | null;
  fields: KnowledgeFieldView;
}): { blocks: B[]; ignored: KnowledgeIgnoredItem[]; problem: KnowledgeProblem | null } {
  const { current, noteId, fields } = input;
  const blocks = [...input.after];
  const ignored: KnowledgeIgnoredItem[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    const id = knowledgeIdOf(b);
    if (id === "") continue;
    const heading = knowledgeHeadingText(b.content);
    const rawOf = (prop: KnowledgePropName): string => str(b.props?.[prop]);
    const stored = current.get(id);
    if (stored !== undefined && readsAsStored(stored, fields, rawOf)) {
      for (const f of BUILTIN) {
        const raw = rawOf(f.prop);
        if (raw !== "" && !isKnowledgeFieldEnabled(fields, f.key) && asWritten(f.key, raw) !== stored[f.info]) ignored.push({ heading, key: f.key, value: raw, reason: "field_disabled" });
      }
      blocks[i] = patched(b, { ...Object.fromEntries(BUILTIN.map(f => [f.prop, stored[f.info]])), knowledgeStatus: stored.status });
      continue;
    }
    if (!KNOWLEDGE_ID_RE.test(id)) return { blocks, ignored, problem: { problem: "bad_id", key: "id", heading } };
    const values: Partial<Record<KnowledgePropName, string>> = {};
    for (const f of BUILTIN) {
      const old = stored ? stored[f.info] : "";
      const raw = rawOf(f.prop);
      const value = asWritten(f.key, raw);
      values[f.prop] = old;
      if (value === old) continue;
      if (!isKnowledgeFieldEnabled(fields, f.key)) {
        if (raw !== "") ignored.push({ heading, key: f.key, value: raw, reason: "field_disabled" });
        continue;
      }
      const reason = builtinValueProblem(f.key, value, fields, id, noteId);
      if (reason === null) values[f.prop] = value;
      else ignored.push({ heading, key: f.key, value: raw, reason });
    }
    const writtenStatus = rawOf("knowledgeStatus");
    let status: KnowledgeStatus;
    if (stored !== undefined && writtenStatus === stored.status) status = stored.status;
    else {
      const parsed = parseKnowledgeStatusInput(writtenStatus);
      if (parsed === null) ignored.push({ heading, key: "status", value: writtenStatus, reason: "bad_status" });
      status = parsed ?? stored?.status ?? "";
      // The stored string is kept when it reads the same, so a legacy "" written back by its exported name changes nothing.
      if (stored !== undefined && sameState(stored.status, status, values.knowledgeVerified!)) status = stored.status;
    }
    blocks[i] = patched(b, { ...values, knowledgeStatus: status });
  }
  return { blocks, ignored, problem: null };
}

export function knowledgeRefsIn(blocks: readonly KnowledgeBlockShape[]): KnowledgeHeadingRef[] {
  const out: KnowledgeHeadingRef[] = [];
  for (const b of blocks) {
    const info = b.type === "heading" ? readKnowledgeInfo(b.props) : null;
    if (info !== null) out.push({ id: info.id, heading: knowledgeHeadingText(b.content) });
  }
  return out;
}
