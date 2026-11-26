/**
 * #93: response-layer wire budget: matches are added in note order, then each note's ord order; once the next one would exceed the budget, **stop adding any match** (no skipping to try a later one).
 * Also "the search bucket is charged before the query" (an exhausted one never touches the DB): pure unit cases with no DB.
 */
import { describe, expect, it } from "vitest";
import type { McpToolCtx } from "../../src/mcp/context.js";
import { assembleSearchPayload, searchNotes, type SearchMatchForModel } from "../../src/mcp/tools/search-notes.js";

const note = (id: string) => ({
  id, title: id, owner: { kind: "user" as const, handle: "h" }, slug: id, url: `/n/h/${id}`, role: "owner",
  updatedAt: "2026-01-01T00:00:00.000Z", lastEdited: null, folder: null, matchedOn: "body" as const, matches: [] as SearchMatchForModel[],
});
const m = (n: number): SearchMatchForModel => ({ sectionId: "s", heading: "", snippet: "x".repeat(n) });

describe("assembleSearchPayload", () => {
  it("enough budget -> all added, no matchesTruncated", () => {
    const out = assembleSearchPayload([note("a"), note("b")], [[m(10), m(10)], [m(10)]], false);
    expect(out.notes.map(n => n.matches.length)).toEqual([2, 1]);
    expect("matchesTruncated" in out).toBe(false);
  });
  it("not enough budget -> stops at the first one that does not fit, adds nothing after it even if it would fit, carries matchesTruncated: true", () => {
    const notes = [note("a"), note("b")];
    const p0 = JSON.stringify({ notes, truncated: false });
    const base = p0.length + JSON.stringify(p0).length + 64;
    // Budget = exactly enough for m(10) and m(1): a "skip m(5000), try the next" implementation would put b's m(1) in ([1, 1]).
    // A looser base + 200 does not fit m(10)+m(1) (122 + 104), so it gives [1, 0] under that implementation too and cannot tell the two apart.
    const cost = (x: SearchMatchForModel) => { const j = JSON.stringify(x); return j.length + JSON.stringify(j).length + 2; };
    const out = assembleSearchPayload(notes, [[m(10), m(5000)], [m(1)]], false, base + cost(m(10)) + cost(m(1)));
    expect(out.notes.map(n => n.matches.length)).toEqual([1, 0]);
    expect(out).toMatchObject({ matchesTruncated: true, truncated: false });
  });

  it("notes themselves exceed budget (e.g. heavy matchedTerms) -> trims trailing notes, sets truncated: true, stays within budget", () => {
    const heavyTerms = ["\u0001".repeat(80), "\u0001".repeat(80)];
    const notes = [note("a"), note("b"), note("c")].map(n => ({ ...n, matchedTerms: heavyTerms }));
    const one = JSON.stringify(notes[0]!);
    const oneCost = one.length + JSON.stringify(one).length + 2;
    const base = JSON.stringify({ notes: [], truncated: false });
    const baseCost = base.length + JSON.stringify(base).length + 64;
    // Budget fits 2 notes (not 3).
    const budget = baseCost + oneCost * 2 + 10;
    const out = assembleSearchPayload(notes, [[m(10)], [m(10)], [m(10)]], false, budget);
    expect(out.notes.map(n => n.id)).toEqual(["a", "b"]);
    expect(out.truncated).toBe(true);
    const serialized = JSON.stringify(out);
    expect(serialized.length + JSON.stringify(serialized).length).toBeLessThanOrEqual(budget);
  });
});

describe("#93 when the bucket is charged", () => {
  it("search bucket exhausted -> too_many_requests, before the query (db untouched)", async () => {
    let touched = 0;
    // any access to db is counted and throws: if the charge moved after the query, the query would hit it first.
    const db = new Proxy({}, { get() { touched += 1; throw new Error("db touched"); } });
    const ctx = { db, userId: "u", limiters: { search: { consume: () => false } } } as unknown as McpToolCtx;
    const r = await searchNotes({ query: "x" }, ctx);
    expect(touched).toBe(0);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("too_many_requests");
  });
});
