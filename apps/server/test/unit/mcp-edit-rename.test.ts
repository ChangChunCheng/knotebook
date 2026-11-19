/**
 * #180: the MCP-side required-field matrix `mcpEditBodySchema` (the five REST routes plus `RENAME_BRANCH`) and the full text of `invalidBodyMessage`.
 * #381: rename now requires `if_match` (the title fingerprint `titleFingerprint`).
 * Strings are written as literals (no strings imported besides implementation constants): only literals pin the wording.
 */
import { describe, expect, it } from "vitest";
import { mcpEditBodySchema, invalidBodyMessage } from "../../src/mcp/tools/edit-note.js";

const FP = "0123456789abcdef";
const SEC = "a".repeat(8);

describe("mcpEditBodySchema matrix", () => {
  it("{op:rename, title, if_match} passes; append without if_match passes (unchanged)", () => {
    expect(mcpEditBodySchema.safeParse({ op: "rename", title: "x", if_match: FP }).success).toBe(true);
    expect(mcpEditBodySchema.safeParse({ op: "append", markdown: "m" }).success).toBe(true);
  });

  it("#381 rename without if_match -> rejected, path is exactly if_match; if_match that is not 16 hex digits -> rejected", () => {
    const r = mcpEditBodySchema.safeParse({ op: "rename", title: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.path)).toEqual([["if_match"]]);
    expect(mcpEditBodySchema.safeParse({ op: "rename", title: "x", if_match: "XYZ" }).success).toBe(false);
  });

  it.each([
    ["markdown", { markdown: "m" }],
    ["section_id", { section_id: SEC }],
  ])("rename + %s -> unrecognized_keys", (_k, extra) => {
    const r = mcpEditBodySchema.safeParse({ op: "rename", title: "x", if_match: FP, ...extra });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.code)).toContain("unrecognized_keys");
  });

  it("rename without title -> rejected, path title; empty title -> rejected", () => {
    const r = mcpEditBodySchema.safeParse({ op: "rename", if_match: FP });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["title"]);
    expect(mcpEditBodySchema.safeParse({ op: "rename", title: "", if_match: FP }).success).toBe(false);
  });

  it.each([
    ["replace_all", { markdown: "m", if_match: FP }],
    ["replace_section", { section_id: SEC, markdown: "m", if_match: FP }],
    ["insert_after", { section_id: SEC, markdown: "m", if_match: FP }],
    ["append", { markdown: "m" }],
    ["delete_section", { section_id: SEC, if_match: FP }],
  ])("%s + title -> unrecognized_keys (only rename accepts title)", (op, rest) => {
    const r = mcpEditBodySchema.safeParse({ op, ...rest, title: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.code)).toContain("unrecognized_keys");
  });
});

describe("invalidBodyMessage full text", () => {
  it("rename missing title: Check: title. + the tail of the full text verbatim", () => {
    expect(invalidBodyMessage("rename", [{ path: ["title"] }])).toBe(
      "This `rename` call does not match what that operation needs. Check: title. replace_section, insert_after and " +
        "delete_section need `section_id`; every operation except delete_section and rename needs `markdown`; every " +
        "operation except append needs `if_match` (for rename, the title's `titleFingerprint`); rename needs `title`, " +
        "and no other operation takes it. Fields that do not belong to the operation are rejected."
    );
  });

  it("#381 rename missing if_match: Check: if_match.; the old sentence 'except append and rename needs `if_match`' is gone", () => {
    const m = invalidBodyMessage("rename", [{ path: ["if_match"] }]);
    expect(m).toContain("Check: if_match.");
    expect(m).not.toContain("except append and rename needs `if_match`");
  });
});
