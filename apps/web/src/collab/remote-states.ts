import { collabUserColor, parseAwarenessCursor } from "@knotebook/shared";

/**
 * #312：awareness 是 client 自報的資料。交給 BlockNote／y-prosemirror 畫遠端游標之前先清洗——
 * 它們會把 `user.color` 原樣寫進 `style`，遇到格式錯誤的 `cursor` 則直接 throw。
 * server 也會重建一次；這裡是第二道，不信任任何舊版或被入侵的 server 轉來的內容。
 */

const FALLBACK_COLOR = "#888888";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HSL_COLOR = /^hsl\((\d{1,3}) (\d{1,3})% (\d{1,3})%\)$/;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * `hsl(H S% L%)` 轉 `#rrggbb`。y-prosemirror 會在顏色後面直接接兩位 alpha（`${color}70`）畫選取底色，
 * `hsl(...)70` 不是合法的 CSS，選取會整個看不見，所以交給它的顏色一定要是 6 位 hex。
 */
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

/** 有 id 一律用 id 算出的顏色（送來的顏色不採信）；沒有 id 只收合法的 `#rrggbb`（AI 代理）；其餘灰色。 */
export function safeCursorColor(user: unknown): string {
  if (!isObject(user)) return FALLBACK_COLOR;
  if (typeof user.id === "string" && user.id !== "") {
    return hslToHex(collabUserColor(user.id)) ?? FALLBACK_COLOR;
  }
  return typeof user.color === "string" && HEX_COLOR.test(user.color) ? user.color : FALLBACK_COLOR;
}

// y-prosemirror 會改寫 user 預設值，BlockNote 也以 clientID 快取游標元素，所以同一個輸入物件要回同一個輸出物件。
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
