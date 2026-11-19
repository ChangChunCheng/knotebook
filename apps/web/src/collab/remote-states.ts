import { collabUserColor, parseAwarenessCursor } from "@knotebook/shared";

// Awareness is self-reported (#312): sanitize before BlockNote/y-prosemirror draw cursors (they
// write `user.color` into `style` as-is and throw on a malformed `cursor`). Second layer after the server's own rebuild.

const FALLBACK_COLOR = "#888888";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HSL_COLOR = /^hsl\((\d{1,3}) (\d{1,3})% (\d{1,3})%\)$/;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

// y-prosemirror appends a two-digit alpha to the color (`${color}70`), so it must be 6-digit hex.
export function hslToHex(hsl: string): string | null {
  const m = HSL_COLOR.exec(hsl);
  if (!m) return null;
  const h = Number(m[1]) % 360;
  const s = Math.min(Number(m[2]), 100) / 100;
  const l = Math.min(Number(m[3]), 100) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** A sent color is not trusted when there is an id; without one (AI agents) only a valid `#rrggbb` is accepted. */
export function safeCursorColor(user: unknown): string {
  if (!isObject(user)) return FALLBACK_COLOR;
  if (typeof user.id === "string" && user.id !== "") {
    return hslToHex(collabUserColor(user.id)) ?? FALLBACK_COLOR;
  }
  return typeof user.color === "string" && HEX_COLOR.test(user.color) ? user.color : FALLBACK_COLOR;
}

// Stable output identity per input object, so decorations don't re-sanitize on each rebuild.
const cache = new WeakMap<object, Record<string, unknown>>();

function sanitizeState(state: Record<string, unknown>): Record<string, unknown> {
  const hit = cache.get(state);
  if (hit) return hit;
  const user = isObject(state.user) ? state.user : {};
  const out: Record<string, unknown> = {
    ...state,
    user: {
      ...(typeof user.id === "string" && user.id !== "" ? { id: user.id } : {}),
      name: typeof user.name === "string" ? user.name : "",
      color: safeCursorColor(user),
    },
    cursor: parseAwarenessCursor(state.cursor),
  };
  cache.set(state, out);
  return out;
}

export function sanitizeRemoteStates(states: ReadonlyMap<number, unknown>): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  for (const [clientId, state] of states) {
    if (isObject(state)) out.set(clientId, sanitizeState(state));
  }
  return out;
}
