import { MCP_LIST_WIRE_BUDGET } from "./limits.js";

/** `structuredContent` plus the JSON-escaped mirror text. */
export function wireCost(v: unknown): number {
  const j = JSON.stringify(v);
  return j.length + JSON.stringify(j).length;
}

/** `,"pageCutShort":true` in both copies is about 42. */
export const PAGE_CUT_RESERVE = 64;

/** Always returns at least 1: a single item is far below the budget by the per-field limits. */
export function countWithinWireBudget(costs: readonly number[], base: number, budget: number = MCP_LIST_WIRE_BUDGET): number {
  let total = base;
  let n = 0;
  for (const cost of costs) {
    // +2: a comma in both copies (an upper bound).
    const add = cost + 2;
    if (n > 0 && total + add > budget) break;
    total += add;
    n += 1;
  }
  return n;
}
