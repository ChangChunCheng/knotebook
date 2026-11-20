/**
 * #108: the truncation functions of the response-size limits table.
 *
 * This family guards the boundaries of `truncateText`, not which fields get truncated: that is covered by the key-set/length assertions in
 * `test/mcp-notes.test.ts`.
 *
 * Since #177 the budget of `truncateText` counts the **JSON-escaped** length (`limits.ts`); `truncateCodeUnits` is the older rule (raw length) used for
 * `read_note_section` paging.
 */
import { describe, expect, it } from "vitest";
import { MCP_SECTION_CHARS, MCP_TEXT_MAX, truncateCodeUnits, truncateText } from "../../src/mcp/limits.js";
import { noteOwnerSchema, noteSummarySchema, ownerForModel, toNoteSummary } from "../../src/mcp/dto.js";

/** A high or low surrogate without its pair. `String.prototype.isWellFormed` needs the ES2024 lib, and this repo targets ES2023. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("#108 truncateText", () => {
  it("exactly 200 code units are not truncated", () => {
    const s = "a".repeat(MCP_TEXT_MAX);
    expect(truncateText(s)).toEqual({ text: s, truncated: false });
  });

  it("201 code units are cut to 200 and marked truncated", () => {
    const s = "a".repeat(MCP_TEXT_MAX + 1);
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX));
  });

  // A surrogate pair (an emoji = two code units) is never split: when the cut lands in the middle of a pair, back off by one and return 199 code units.
  // Splitting would hand the model a lone surrogate, which JSON serialization doesn't reject and silently sends as a bad character.
  it("a cut in the middle of a surrogate pair backs off by one, producing no lone surrogate", () => {
    const s = "a".repeat(MCP_TEXT_MAX - 1) + "\u{1F600}" + "tail";
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX - 1);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX - 1));
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
    // Contrast: a naive `slice(0, 200)` on the same input does cut a lone surrogate; without this line the "length 199" assertion above doesn't show why it is 199.
    expect(LONE_SURROGATE.test(s.slice(0, MCP_TEXT_MAX))).toBe(true);
  });
});

/** Length after JSON escaping (without the surrounding quotes): the budget unit of `truncateText`, taken straight from `JSON.stringify` as an independent source of truth. */
const escapedLength = (s: string): number => JSON.stringify(s).length - 2;

describe("#177 truncateText counts by length after JSON escaping", () => {
  it("C0 (U+0001, escapes to 6): 40 of them keep only 33 (198), without cutting a character in half", () => {
    const out = truncateText("\u0001".repeat(40));
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("\u0001".repeat(33));
    expect(escapedLength(out.text)).toBe(198);
  });

  it("C0 that exactly fills the budget is not truncated; one more code unit drops the whole character", () => {
    const fits = `${"a".repeat(MCP_TEXT_MAX - 6)}\u0001`; // 194 + 6 = 200
    expect(truncateText(fits)).toEqual({ text: fits, truncated: false });
    const over = `${"a".repeat(MCP_TEXT_MAX - 5)}\u0001`; // 195 + 6 = 201
    expect(truncateText(over)).toEqual({ text: "a".repeat(MCP_TEXT_MAX - 5), truncated: true });
  });

  it.each([
    ['"', "double quote"],
    ["\\", "backslash"],
    ["\n", "newline (short escape)"],
  ])("%j (%s, escapes to 2): 100 are not truncated, 101 are cut to 100", ch => {
    expect(truncateText(ch.repeat(100))).toEqual({ text: ch.repeat(100), truncated: false });
    const out = truncateText(ch.repeat(101));
    expect(out).toEqual({ text: ch.repeat(100), truncated: true });
    expect(escapedLength(out.text)).toBe(MCP_TEXT_MAX);
  });

  it("non-ASCII that needs no escaping (CJK, U+2028, DEL) still counts by raw length: 201 are cut to 200", () => {
    for (const ch of ["中", " ", "\u007f", "\u0085"]) {
      expect(truncateText(ch.repeat(MCP_TEXT_MAX))).toEqual({ text: ch.repeat(MCP_TEXT_MAX), truncated: false });
      expect(truncateText(ch.repeat(MCP_TEXT_MAX + 1))).toEqual({ text: ch.repeat(MCP_TEXT_MAX), truncated: true });
    }
  });

  it("a surrogate pair next to an escaped character is kept or dropped as a whole pair, never leaving a lone surrogate", () => {
    const fits = `${'"'.repeat(99)}\u{1F600}`; // 198 + 2 = 200
    expect(truncateText(fits)).toEqual({ text: fits, truncated: false });
    const s = `${'"'.repeat(99)}a\u{1F600}`; // 198 + 1 = 199, the pair doesn't fit
    const out = truncateText(s);
    expect(out).toEqual({ text: `${'"'.repeat(99)}a`, truncated: true });
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
  });

  // Compare against `JSON.stringify` bit by bit: every code unit (including lone surrogates) repeated 250 times; the number kept must be exactly
  // floor(200 / escaped length of that character), proving both "not over budget" and "nothing dropped needlessly".
  it("every code unit 0x0000-0xFFFF: the number kept = floor(200 / JSON.stringify escaped length)", () => {
    const bad: string[] = [];
    for (let c = 0; c <= 0xffff; c += 1) {
      const ch = String.fromCharCode(c);
      const cost = escapedLength(ch);
      const out = truncateText(ch.repeat(250));
      if (out.text !== ch.repeat(Math.floor(MCP_TEXT_MAX / cost)) || !out.truncated) bad.push(c.toString(16));
    }
    expect(bad).toEqual([]);
  });

  // Deterministic randomness over mixed characters: the invariants are escaped length <= 200, a prefix of the original string, and one more character (or a whole pair) would go over.
  it("mixed strings (fixed seed, 500 sets): escaped <= 200, a prefix, maximal", () => {
    const alphabet = ["a", "中", '"', "\\", "\n", "\u0001", "\u001f", "\u{1F600}", "\uD800", " "];
    let seed = 177;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 500; k += 1) {
      let s = "";
      const len = 1 + rnd(300);
      for (let j = 0; j < len; j += 1) s += alphabet[rnd(alphabet.length)];
      const out = truncateText(s);
      expect(s.startsWith(out.text)).toBe(true);
      expect(escapedLength(out.text)).toBeLessThanOrEqual(MCP_TEXT_MAX);
      expect(out.truncated).toBe(out.text !== s);
      if (out.truncated) {
        const rest = s.slice(out.text.length);
        const c0 = rest.charCodeAt(0);
        const step = c0 >= 0xd800 && c0 <= 0xdbff && /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(rest) ? 2 : 1;
        expect(escapedLength(s.slice(0, out.text.length + step))).toBeGreaterThan(MCP_TEXT_MAX);
      }
    }
  });
});

describe("#177 truncateCodeUnits (read_note_section paging) still counts raw length", () => {
  it("C0 is not counted as escaped: 4001 U+0001 are cut to 4000", () => {
    const out = truncateCodeUnits("\u0001".repeat(MCP_SECTION_CHARS + 1), MCP_SECTION_CHARS);
    expect(out).toEqual({ text: "\u0001".repeat(MCP_SECTION_CHARS), truncated: true });
  });

  it("a cut in the middle of a surrogate pair backs off by one", () => {
    const s = `${"a".repeat(MCP_SECTION_CHARS - 1)}\u{1F600}`;
    expect(truncateCodeUnits(s, MCP_SECTION_CHARS)).toEqual({ text: "a".repeat(MCP_SECTION_CHARS - 1), truncated: true });
  });
});

describe("#177 DTO fields returned to the model go through the same truncation", () => {
  const groupRow = (groupName: string) => ({ ownerHandle: null, groupId: "g-1", groupName });

  it("group name: an ordinary name as-is, no nameTruncated", () => {
    expect(ownerForModel(groupRow("Team"))).toEqual({ kind: "group", id: "g-1", name: "Team" });
  });

  it("group name: 80 U+0001 (a valid value within the DB limit) are cut to 33 with nameTruncated, and pass outputSchema", () => {
    const owner = ownerForModel(groupRow("\u0001".repeat(80)));
    expect(owner).toEqual({ kind: "group", id: "g-1", name: "\u0001".repeat(33), nameTruncated: true });
    expect(noteOwnerSchema.safeParse(owner).success).toBe(true);
  });

  it("group name: 80 double quotes (160 after escaping) are not truncated", () => {
    expect(ownerForModel(groupRow('"'.repeat(80)))).toEqual({ kind: "group", id: "g-1", name: '"'.repeat(80) });
  });

  it("title: 101 double quotes are cut to 100 with titleTruncated, and pass outputSchema", () => {
    const summary = toNoteSummary(
      {
        id: "n-1",
        title: '"'.repeat(101),
        ownerHandle: "alice",
        groupId: null,
        groupName: null,
        slug: "s",
        updatedAt: new Date(0),
        lastEditedAt: null,
        lastEditedAgentLabel: null,
        editorHandle: null,
        viewerFolderId: null,
      },
      "owner",
      undefined
    );
    expect(summary.title).toBe('"'.repeat(100));
    expect(summary.titleTruncated).toBe(true);
    expect(noteSummarySchema.safeParse(summary).success).toBe(true);
  });

  // folder: viewerFolderId is set but the name can't be found (deleted between the two statements) -> folder: null, still passes outputSchema; found -> { id, name }.
  it("folder: name not found -> null still passes outputSchema; found -> { id, name }", () => {
    const row = {
      id: "n-1", title: "t", ownerHandle: "alice", groupId: null, groupName: null, slug: "s", updatedAt: new Date(0),
      lastEditedAt: null, lastEditedAgentLabel: null, editorHandle: null, viewerFolderId: "f-1",
    };
    const missing = toNoteSummary(row, "owner", undefined);
    expect(missing.folder).toBeNull();
    expect(noteSummarySchema.safeParse(missing).success).toBe(true);
    const found = toNoteSummary(row, "owner", "F");
    expect(found.folder).toEqual({ id: "f-1", name: "F" });
    expect(noteSummarySchema.safeParse(found).success).toBe(true);
  });
});
