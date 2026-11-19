// Every width written to the document goes through `ratiosFromPixels` (two decimals in `[0.1, 10]`, summing to the column count): shared `canonicalColumnsLine` accepts only that form, so it round-trips through MCP.
import { clampColumnWidth } from "@knotebook/shared";

// The rounding difference goes to a column in `changed`, so a divider drag changes only the two dragged columns.
export function ratiosFromPixels(px: readonly number[], changed?: readonly number[]): number[] {
  const n = px.length;
  const sum = px.reduce((a, b) => a + b, 0);
  if (n === 0) return [];
  if (!(sum > 0)) return px.map(() => 1);
  // Integer cents so the sum check isn't thrown off by float error.
  const cents = px.map((p) => Math.round(clampColumnWidth((n * p) / sum) * 100));
  const diff = n * 100 - cents.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const candidates = (changed ?? px.map((_, i) => i)).filter((i) => i >= 0 && i < n);
    let target = -1;
    for (const i of candidates) if (target < 0 || cents[i]! > cents[target]! || (cents[i] === cents[target] && i < target)) target = i;
    if (target >= 0) cents[target] = cents[target]! + diff;
  }
  // The final clamp isn't passed on to other columns, so the sum can differ from the column count only at extreme ratios; real drags can't get there (every column has a minimum pixel width).
  return cents.map((c) => clampColumnWidth(c / 100));
}

export function dividerResize(pL: number, pR: number, mL: number, mR: number, delta: number): [number, number] {
  const total = pL + pR;
  const left = Math.min(Math.max(pL + delta, mL), total - mR);
  return [left, total - left];
}

export function expandColumnPixels(
  px: readonly number[],
  mins: readonly number[],
  k: number,
  need: number,
): { px: number[]; granted: number } {
  if (!(need > 0)) return { px: [...px], granted: 0 };
  const slack = px.map((p, j) => (j === k ? 0 : Math.max(0, p - (mins[j] ?? 0))));
  const total = slack.reduce((a, b) => a + b, 0);
  const granted = Math.min(need, total);
  if (!(granted > 0)) return { px: [...px], granted: 0 };
  return { px: px.map((p, j) => (j === k ? p + granted : p - (granted * slack[j]!) / total)), granted };
}

export function equalHeightWidths(aspects: readonly (number | null)[]): number[] | null {
  if (aspects.length === 0 || aspects.some((a) => a === null || !(a > 0))) return null;
  return ratiosFromPixels(aspects as readonly number[]);
}

export function addColumnWidths(existing: readonly number[], insertIndex: number): number[] {
  const mean = existing.length ? existing.reduce((a, b) => a + b, 0) / existing.length : 1;
  const next = [...existing];
  next.splice(insertIndex, 0, mean);
  return ratiosFromPixels(next);
}

export function changedIndices(before: readonly number[], after: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) out.push(i);
  return out;
}
