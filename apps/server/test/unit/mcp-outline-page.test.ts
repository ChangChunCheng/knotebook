/**
 * #108: boundaries of outline paging (at most 100 entries at a time).
 *
 * This family guards `buildOutlinePage` itself; which fields are dropped or truncated is covered by the key-set and length assertions in
 * `test/mcp-content.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { OutlineEntry } from "../../src/notes/editing/fingerprint.js";
import { buildOutlinePage } from "../../src/mcp/outline-page.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX } from "../../src/mcp/limits.js";

/** Carries `fingerprint`/`blockIds` verbatim: these two fields must NOT appear in the return value. */
function entries(n: number, heading = (i: number) => `S${i}`): OutlineEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    sectionId: i === 0 ? "_top" : `sec-${i}`,
    level: i === 0 ? 0 : 1,
    heading: heading(i),
    chars: i,
    blockIds: [`b-${i}`],
    fingerprint: "deadbeefdeadbeef",
  }));
}

describe("#108 buildOutlinePage", () => {
  it("fewer than 100 entries: all returned, truncated false, nextSectionOffset null", () => {
    const page = buildOutlinePage(entries(7), 0);
    expect(page.sections).toHaveLength(7);
    expect(page.truncated).toBe(false);
    expect(page.nextSectionOffset).toBeNull();
  });

  it("exactly 100 entries is not truncation (boundary: > means truncated; >= would issue an extra empty second page)", () => {
    const page = buildOutlinePage(entries(MCP_PAGE_MAX), 0);
    expect(page.sections).toHaveLength(MCP_PAGE_MAX);
    expect(page.truncated).toBe(false);
    expect(page.nextSectionOffset).toBeNull();
  });

  it("101 entries: first page 100 + truncated + nextSectionOffset 100; the second page has 1 entry and ends it", () => {
    const all = entries(MCP_PAGE_MAX + 1);
    const p1 = buildOutlinePage(all, 0);
    expect(p1.sections).toHaveLength(MCP_PAGE_MAX);
    expect(p1.truncated).toBe(true);
    expect(p1.nextSectionOffset).toBe(MCP_PAGE_MAX);
    const p2 = buildOutlinePage(all, p1.nextSectionOffset!);
    expect(p2.sections).toHaveLength(1);
    expect(p2.truncated).toBe(false);
    expect(p2.nextSectionOffset).toBeNull();
    // The two pages put back together give the full set: order unchanged, no duplicates, none missing.
    expect([...p1.sections, ...p2.sections].map(s => s.sectionId)).toEqual(all.map(s => s.sectionId));
  });

  it("sectionOffset equal to or beyond the section count -> empty array + truncated false + nextSectionOffset null (not an error)", () => {
    for (const offset of [7, 8, 10_000]) {
      const page = buildOutlinePage(entries(7), offset);
      expect(page.sections).toEqual([]);
      expect(page.truncated).toBe(false);
      expect(page.nextSectionOffset).toBeNull();
    }
  });

  it("the key set of each entry is exactly {sectionId, level, heading, chars}; fingerprints and blockIds are dropped", () => {
    const page = buildOutlinePage(entries(3), 0);
    for (const s of page.sections) {
      expect(Object.keys(s).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    expect(JSON.stringify(page)).not.toContain("deadbeefdeadbeef");
    expect(JSON.stringify(page)).not.toContain("b-0");
  });

  // #108: `withFingerprints: true` is the explicit exception to "outline carries no fingerprints", passed only in the successful response of
  // `edit_note` (kept at parity with REST). The flag is off by default, so forgetting to turn it off can't happen, only deliberately turning it on.
  // The reverse (no fingerprints by default) has no separate case: the key-set assertion above already covers it.
  it("withFingerprints: true -> every entry gets one more field, fingerprint, equal to that input entry verbatim", () => {
    // Different fingerprint per entry: with one shared value, picking the wrong row would also stay green.
    const input = entries(3).map((e, i) => ({ ...e, fingerprint: `abcdef01234567${i}${i}` }));
    const page = buildOutlinePage(input, 0, { withFingerprints: true });
    expect(page.sections).toHaveLength(3);
    for (const [i, s] of page.sections.entries()) {
      expect(Object.keys(s).sort()).toEqual(["chars", "fingerprint", "heading", "level", "sectionId"].sort());
      expect(s.fingerprint).toBe(input[i]!.fingerprint);
    }
  });

  it("heading cut to 200 with headingTruncated; no such key when not truncated", () => {
    const page = buildOutlinePage(entries(2, i => (i === 1 ? "H".repeat(500) : "short")), 0);
    expect(page.sections[0]!.heading).toBe("short");
    expect("headingTruncated" in page.sections[0]!).toBe(false);
    expect(page.sections[1]!.heading).toBe("H".repeat(MCP_TEXT_MAX));
    expect(page.sections[1]!.headingTruncated).toBe(true);
  });

  // #177: heading goes through `truncateText`, whose budget counts after JSON escaping. One C0 counts 6, so only 33 are kept with the flag;
  // switching `buildOutlinePage` back to raw-length truncation (or bypassing `truncateText`) fails this case.
  it("#177: a heading containing C0 is cut by escaped length (40 U+0001 -> 33 + headingTruncated)", () => {
    const page = buildOutlinePage(entries(2, i => (i === 1 ? "\u0001".repeat(40) : "short")), 0);
    expect(page.sections[1]!.heading).toBe("\u0001".repeat(33));
    expect(page.sections[1]!.headingTruncated).toBe(true);
    expect(JSON.stringify(page.sections[1]!.heading).length - 2).toBeLessThanOrEqual(MCP_TEXT_MAX);
  });
});
