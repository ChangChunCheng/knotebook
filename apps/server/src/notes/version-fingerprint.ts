/**
 * Separate from `editing/fingerprint.ts`'s `outlineOf().whole`: that one is the #106 `if_match` contract (`canonicalizeNode`, must not change); this one only decides "was it changed" for versioning. Differences: (1) an empty `Y.XmlText` counts as absent (typing a character then deleting leaves `T[]` vs a new empty paragraph's `[]`); (2) a top level of only default-attribute empty paragraphs (zero or many) is vacuum (two people opening an empty note concurrently merge into two empty paragraphs); (3) never throws: explicit stack (`canonicalizeNode` recursion hits RangeError at 5000 levels), document-order walk with no id lookup, depth-bounded `stableValue`; (4) attribute values strictly `===` the element type's schema default count as absent (notes written under an older schema lack newer default attrs, and y-prosemirror writes them back after a type-and-delete). Types differ → not equal (`level: "1"` ≠ `1`); attributes with undefined are always absent.
 * Same hash as `fingerprintOf` with a `V2:` prefix so values can't be mistaken for `if_match` (V1 predates (4)); no migration: an old V1 base counts as changed once, at most one extra version.
 * Knows BlockNote 0.52 structure names only; the pin case in `version-fingerprint.test.ts` goes red on upgrade.
 */
import * as Y from "yjs";
import { createHeadlessNoteSchema } from "@knotebook/shared";
import { fingerprintOf } from "./editing/fingerprint.js";

/** BlockNote 0.52.1 `defaultProps` (pinned by `test/unit/version-fingerprint.test.ts`). */
export const PARAGRAPH_DEFAULT_PROPS: Readonly<Record<string, string>> = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
};

export const VACUUM_VERSION_FINGERPRINT = fingerprintOf("V2:vacuum");

/** `config` isn't always an object: in 0.52 inline `text`/`link` are plain strings in `inlineContentSchema`. */
type SchemaConfigs = Record<string, unknown>;
interface SchemaLike {
  blockSchema?: SchemaConfigs;
  inlineContentSchema?: SchemaConfigs;
  styleSchema?: SchemaConfigs;
}
type WarnFn = (obj: object, msg: string) => void;
const consoleWarn: WarnFn = (obj, msg) => console.warn(msg, obj);

/** Derived from the schema, not a hand-written table (it would drift). If `load` throws (the shared schema can't load in some environment), fall back to an empty table and warn once: the fingerprint still works, it just doesn't ignore defaults (the never-throws invariant holds). */
export function buildDefaultPropsByType(load: () => SchemaLike, warn: WarnFn = consoleWarn): Record<string, Record<string, unknown>> {
  try {
    const schema = load();
    const table: Record<string, Record<string, unknown>> = {};
    for (const configs of [schema.blockSchema, schema.inlineContentSchema, schema.styleSchema]) {
      for (const [type, config] of Object.entries(configs ?? {})) {
        const propSchema = config !== null && typeof config === "object" ? (config as { propSchema?: unknown }).propSchema : undefined;
        if (propSchema === null || typeof propSchema !== "object") continue;
        const defaults: Record<string, unknown> = {};
        for (const [prop, spec] of Object.entries(propSchema as Record<string, unknown>)) {
          if (spec !== null && typeof spec === "object" && "default" in spec && spec.default !== undefined) defaults[prop] = spec.default;
        }
        if (Object.keys(defaults).length > 0) table[type] = defaults;
      }
    }
    return table;
  } catch (err) {
    warn({ err }, "版本指紋的預設值表建不起來（shared schema 載入失敗），退回空表：值等於預設的屬性照常參與指紋");
    return {};
  }
}

export const DEFAULT_PROPS_BY_TYPE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = buildDefaultPropsByType(
  // Config only, no DOM; the base URL doesn't affect propSchema.
  () => createHeadlessNoteSchema("http://localhost/"),
);

/** `Object.hasOwn` lookups, so names like `constructor` don't hit the prototype. */
function isSchemaDefault(nodeName: string, attr: string, value: unknown): boolean {
  if (!Object.hasOwn(DEFAULT_PROPS_BY_TYPE, nodeName)) return false;
  const defaults = DEFAULT_PROPS_BY_TYPE[nodeName]!;
  return Object.hasOwn(defaults, attr) && defaults[attr] === value;
}

/** Deeper parts become `"…"` (a malicious deep attribute value mustn't blow the stack); differences past it don't reach the fingerprint. */
const VALUE_DEPTH_MAX = 32;

/** Same shape as `stable()` in shared `note-sections.ts`, plus: depth limit, bigint/Uint8Array as strings (`JSON.stringify` throws on bigint), and `Y.AbstractType` not expanded (parent pointers cycle). */
function stableValue(value: unknown, depth = 0): string {
  if (depth > VALUE_DEPTH_MAX) return '"…"';
  if (value === null) return "null";
  if (value instanceof Y.AbstractType) return JSON.stringify(`Y:${value.constructor.name}`);
  if (value instanceof Uint8Array) return JSON.stringify(`bin:${Buffer.from(value).toString("base64")}`);
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (Array.isArray(value)) return `[${value.map(v => stableValue(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableValue(o[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function textToken(t: Y.XmlText): string {
  const delta = t.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
  return `T${stableValue(delta.map(d => ({ insert: d.insert, attributes: d.attributes ?? {} })))}`;
}

function isDefaultEmptyParagraphContainer(node: unknown): boolean {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer") return false;
  if (Object.keys(node.getAttributes()).some(k => k !== "id")) return false;
  if (node.length !== 1) return false;
  const p = node.get(0);
  if (!(p instanceof Y.XmlElement) || p.nodeName !== "paragraph") return false;
  for (const [k, v] of Object.entries(p.getAttributes() as Record<string, unknown>)) {
    if (!Object.hasOwn(PARAGRAPH_DEFAULT_PROPS, k) || PARAGRAPH_DEFAULT_PROPS[k] !== v) return false;
  }
  return p.toArray().every(c => c instanceof Y.XmlText && c.length === 0);
}

function isVacuum(fragment: Y.XmlFragment): boolean {
  if (fragment.length === 0) return true;
  if (fragment.length !== 1) return false;
  const group = fragment.get(0);
  return group instanceof Y.XmlElement && group.nodeName === "blockGroup" && group.toArray().every(isDefaultEmptyParagraphContainer);
}

type Frame = Y.XmlElement | Y.XmlText | string;

function pushChildren(stack: Frame[], kids: unknown[]): void {
  const kept = kids.filter((c): c is Y.XmlElement | Y.XmlText => c instanceof Y.XmlElement || (c instanceof Y.XmlText && c.length > 0));
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    stack.push(kept[i]!);
    if (i > 0) stack.push("|");
  }
}

function serialize(fragment: Y.XmlFragment): string {
  const out: string[] = ["F["];
  const stack: Frame[] = ["]"];
  pushChildren(stack, fragment.toArray());
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (typeof f === "string") {
      out.push(f);
      continue;
    }
    if (f instanceof Y.XmlText) {
      out.push(textToken(f));
      continue;
    }
    const attrs = f.getAttributes() as Record<string, unknown>;
    const kept = Object.keys(attrs)
      // undefined attrs count as absent: `numberedListItem.start` and image/video `previewWidth` default to undefined (not in the table), and y-prosemirror writes undefined into Yjs when rebuilding nodes.
      .filter(k => k !== "id" && attrs[k] !== undefined && !isSchemaDefault(f.nodeName, k, attrs[k]))
      .sort()
      .map(k => `${JSON.stringify(k)}=${stableValue(attrs[k])}`);
    out.push(`E${JSON.stringify(f.nodeName)}(${kept.join(";")})[`);
    stack.push("]");
    pushChildren(stack, f.toArray());
  }
  return out.join("");
}

export function versionFingerprint(fragment: Y.XmlFragment): string {
  return isVacuum(fragment) ? VACUUM_VERSION_FINGERPRINT : fingerprintOf(`V2:${serialize(fragment)}`);
}
