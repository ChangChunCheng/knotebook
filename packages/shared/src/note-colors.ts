// Unknown colors are rejected, not stripped: BlockNote would store them but the editor wouldn't show them.
// Traversal is iterative: nesting depth comes from caller-supplied markdown.
export const PALETTE_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
const PALETTE: ReadonlySet<string> = new Set(PALETTE_COLORS);
const COLOR_KEYS = ["textColor", "backgroundColor"] as const;

export const isPaletteColor = (v: unknown): v is string => typeof v === "string" && PALETTE.has(v);

export const CUSTOM_COLOR_RE = /^#[0-9a-f]{6}$/;
export const isCustomColor = (v: unknown): v is string => typeof v === "string" && CUSTOM_COLOR_RE.test(v);
export const isShownColor = (v: unknown): v is string => v !== "default" && (isPaletteColor(v) || isCustomColor(v));

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgb\([ \t\n\r\f]*(\d+(?:\.\d+)?)[ \t\n\r\f]*,[ \t\n\r\f]*(\d+(?:\.\d+)?)[ \t\n\r\f]*,[ \t\n\r\f]*(\d+(?:\.\d+)?)[ \t\n\r\f]*\)$/;

export function canonicalColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (isPaletteColor(v)) return v;
  const h = HEX_RE.exec(v);
  if (h) {
    let d = h[1]!.toLowerCase();
    if (d.length === 4) {
      if (d[3] !== "f") return null;
      d = d.slice(0, 3);
    } else if (d.length === 8) {
      if (d.slice(6) !== "ff") return null;
      d = d.slice(0, 6);
    }
    if (d.length === 3) d = d[0]! + d[0]! + d[1]! + d[1]! + d[2]! + d[2]!;
    return `#${d}`;
  }
  const m = RGB_RE.exec(v);
  if (m) {
    let out = "#";
    for (const s of [m[1]!, m[2]!, m[3]!]) {
      const n = Number(s);
      if (!(n >= 0 && n <= 255)) return null;
      out += Math.round(n).toString(16).padStart(2, "0");
    }
    return out;
  }
  return null;
}

function normalizeColorsIn(rec: unknown): string | null {
  if (rec === null || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  for (const k of COLOR_KEYS) {
    const v = r[k];
    if (v === undefined) continue;
    const c = canonicalColor(v);
    if (c === null) return String(v);
    r[k] = c;
  }
  return null;
}

/**
 * Returns String(value) of a rejected color, not necessarily the first in document order. On a non-null result `blocks` may be
 * partly modified: discard them.
 */
export function normalizeNoteColors(blocks: readonly unknown[]): string | null {
  const stack: unknown[] = [];
  const pushAll = (xs: readonly unknown[]) => {
    for (const x of xs) stack.push(x); // not push(...xs): spreading a huge array as arguments overflows the stack
  };
  pushAll(blocks);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      pushAll(n); // legacy table cell: a bare inline array
      continue;
    }
    const o = n as { props?: unknown; styles?: unknown; content?: unknown; children?: unknown };
    const hit = normalizeColorsIn(o.props) ?? normalizeColorsIn(o.styles);
    if (hit !== null) return hit;
    if (Array.isArray(o.content)) pushAll(o.content);
    else if (o.content !== null && typeof o.content === "object") {
      const rows = (o.content as { rows?: unknown }).rows;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const cells = r !== null && typeof r === "object" ? (r as { cells?: unknown }).cells : undefined;
          if (Array.isArray(cells)) pushAll(cells);
        }
      }
    }
    if (Array.isArray(o.children)) pushAll(o.children);
  }
  return null;
}
