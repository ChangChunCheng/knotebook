// Input window: 40 code points before the hit, the hit, 160 after; the caller supplies the cost function (JSON-escaped for MCP, code units for REST); budget = max − 2 (each `…` costs 1). Walks by code point (same unit as PG's substr), so it never splits a surrogate pair. The hit start is always included; a third of the leftover budget goes to leading context. No trailing context if the hit isn't complete; context whitespace collapses, the hit's doesn't. Result cost ≤ max. Holds only if `lower()` keeps length (libc locale; ICU can shift the window), so model-facing text says only "near the first hit".
const WS = /\s/u;

export interface SnippetWindow {
  win: string;
  lead: number;
  qlen: number;
  winStart: number;
  bodyLen: number;
}

export function buildSnippet(w: SnippetWindow, max: number, cost: (cp: string) => number): string {
  const cps = Array.from(w.win);
  const budget = max - 2;
  const lead = Math.min(Math.max(w.lead, 0), cps.length);
  const hitEnd = Math.min(lead + w.qlen, cps.length);
  let used = 0;
  let right = lead;
  while (right < hitEnd) {
    const c = cost(cps[right]!);
    if (used + c > budget) break;
    used += c;
    right += 1;
  }
  const hit = cps.slice(lead, right).join("");

  const leftBudget = Math.floor((budget - used) / 3);
  let leftUsed = 0;
  let left = lead;
  const before: string[] = [];
  let prevSpace = false;
  while (left > 0) {
    const ch = cps[left - 1]!;
    const isWs = WS.test(ch);
    if (isWs && prevSpace) {
      left -= 1;
      continue;
    }
    const piece = isWs ? " " : ch;
    const c = cost(piece);
    if (leftUsed + c > leftBudget) break;
    leftUsed += c;
    before.push(piece);
    prevSpace = isWs;
    left -= 1;
  }
  used += leftUsed;

  const after: string[] = [];
  let end = right;
  prevSpace = false;
  if (right === hitEnd) {
    while (end < cps.length) {
      const ch = cps[end]!;
      const isWs = WS.test(ch);
      if (isWs && prevSpace) {
        end += 1;
        continue;
      }
      const piece = isWs ? " " : ch;
      const c = cost(piece);
      if (used + c > budget) break;
      used += c;
      after.push(piece);
      prevSpace = isWs;
      end += 1;
    }
  }
  const head = w.winStart + left > 1 ? "…" : "";
  const tail = w.winStart + end - 1 < w.bodyLen ? "…" : "";
  return head + before.reverse().join("") + hit + after.join("") + tail;
}
