/**
 * #93: snippet algorithm. cost = cost after the MCP's JSON escaping (`escapedLength`).
 * Guarantees: under the libc locale the match start is included; a match whose escaped cost is <= 158 is included whole; the escaped result is <= 160.
 */
import { describe, expect, it } from "vitest";
import { MCP_SNIPPET_MAX, escapedLength } from "../../src/mcp/limits.js";
import { buildSnippet } from "../../src/notes/search-snippet.js";

/** Simulates the SQL window (search-sql.ts: 40 code points before, the match, 160 after; win_start is 1-based). */
function windowOf(body: string, query: string) {
  const cps = Array.from(body);
  const lower = Array.from(body.toLowerCase());
  const q = Array.from(query.toLowerCase());
  let p0 = -1;
  for (let i = 0; i + q.length <= lower.length; i += 1) if (q.every((c, k) => lower[i + k] === c)) { p0 = i; break; }
  if (p0 < 0) throw new Error("no hit");
  const p = p0 + 1;
  const winStart = Math.max(p - 40, 1);
  const win = cps.slice(winStart - 1, winStart - 1 + 40 + q.length + 160).join("");
  return { win, lead: p - winStart, qlen: q.length, winStart, bodyLen: cps.length };
}
const snip = (body: string, q: string) => buildSnippet(windowOf(body, q), MCP_SNIPPET_MAX, escapedLength);
const esc = (s: string) => JSON.stringify(s).length - 2;

describe("snippet", () => {
  it("match at section start: no leading ellipsis; at the end: no trailing ellipsis; in the middle: both", () => {
    expect(snip("zeta and more", "zeta")).toBe("zeta and more");
    expect(snip("some words zeta", "zeta")).toBe("some words zeta");
    const mid = snip(`${"a ".repeat(100)}zeta${" b".repeat(200)}`, "zeta");
    expect(mid.startsWith("…")).toBe(true);
    expect(mid.endsWith("…")).toBe(true);
    expect(mid).toContain("zeta");
  });
  it("ellipsis off-by-one boundary: exactly 0 characters left outside the snippet -> no ellipsis; exactly 1 left -> ellipsis (before and after each)", () => {
    // After: match at the start, cost 4, after-budget 158 - 4 = 154 `x` characters.
    expect(snip(`zeta${"x".repeat(154)}`, "zeta")).toBe(`zeta${"x".repeat(154)}`);
    expect(snip(`zeta${"x".repeat(155)}`, "zeta")).toBe(`zeta${"x".repeat(154)}…`);
    // Before: the window carries only the 40 characters before the match (before-budget 51 is not used up), so the before text is exactly the window; one more character in the body falls outside it.
    expect(snip(`${"y".repeat(40)}zeta`, "zeta")).toBe(`${"y".repeat(40)}zeta`);
    expect(snip(`${"y".repeat(41)}zeta`, "zeta")).toBe(`…${"y".repeat(40)}zeta`);
  });
  it("consecutive whitespace (including newlines) in the before/after text collapses to one space; the match itself is not collapsed and keeps the body's original case", () => {
    expect(snip("pre \n\n  ZeTa   x  y", "zeta")).toBe("pre ZeTa x y");
    expect(snip("pre x  y post", "x  y")).toBe("pre x  y post");
  });
  it("40 U+0001 before the match + match -> the whole match is in the snippet (an older algorithm that cut the window first and computed the budget after would drop it)", () => {
    const s = snip(`${"\u0001".repeat(40)}zeta tail`, "zeta");
    expect(s).toContain("zeta tail");
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("a query of 200 \" (400 after escaping) -> snippet starts at the match start, escaped length <= 160", () => {
    const q = '"'.repeat(200);
    const s = snip(`pre ${q} post`, q);
    expect(s.startsWith('…"')).toBe(true);
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("escaped length <= 160 for any input (mixed backslash-quote, C0, CJK, emoji)", () => {
    const body = `${"\\\"\u0001中😀".repeat(60)}zeta${"\\\"\u0002文😀".repeat(80)}`;
    expect(esc(snip(body, "zeta"))).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("emoji on both sides of the match and inside it -> match included, no lone surrogate, <= 160", () => {
    const s = snip(`${"😀".repeat(50)}ze😀ta${"😀".repeat(80)}`, "ze😀ta");
    expect(s).toContain("ze😀ta");
    expect(JSON.stringify(s)).not.toMatch(/\\ud[89a-f]/i);
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
});
