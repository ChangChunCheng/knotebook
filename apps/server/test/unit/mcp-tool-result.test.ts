/**
 * #108, the unit half: `toolError()` is the only construction point of tool errors that **we ourselves produce**,
 * and `content[0].text` must be a verbatim mirror of `structuredContent`.
 *
 * The four paths the SDK produces by itself (unknown tool name, input schema mismatch, output validation failure, uncaught exception) are not covered
 * here and can't be intercepted: they have no `code` and no `structuredContent`.
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolError, toolResultWithImage } from "../../src/mcp/tool-result.js";

describe("#108 toolError", () => {
  it("returns isError + structuredContent, and content[0].text is exactly the JSON of structuredContent", () => {
    const result = toolError("not_found", "That note does not exist.");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "not_found", message: "That note does not exist." });
    expect(result.structuredContent!.message).toBeTruthy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });

  it("extra goes into structuredContent, the mirror equality still holds", () => {
    const result = toolError("section_not_found", "No such section.", { outline: { sections: [], truncated: false } });
    expect(result.structuredContent).toEqual({
      code: "section_not_found",
      message: "No such section.",
      outline: { sections: [], truncated: false },
    });
    expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
  });

  it("code is taken verbatim from ERROR_CODES (single source of truth for error codes)", () => {
    for (const code of ["not_found", "forbidden", "section_not_found", "too_many_requests", "invalid_body", "internal"] as const) {
      const result = toolError(code, "x");
      expect(ERROR_CODES).toContain(result.structuredContent!.code);
    }
  });

  it("the mirror is a verbatim string comparison, not 'both sides parse'", () => {
    // Catches writing content with JSON.stringify(..., null, 2) or composing a separate text.
    const result = toolError("internal", `a"b\\c`);
    expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});

describe("#200 toolResultWithImage", () => {
  it("content[0] mirrors structuredContent, content[1] is an image, structuredContent has no data; passes CallToolResultSchema", () => {
    const meta = { noteId: "n", uploadId: "u", mimeType: "image/png", bytes: 3 };
    const r = toolResultWithImage(meta, { data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" });
    expect(r.content[0]).toEqual({ type: "text", text: JSON.stringify(r.structuredContent) });
    expect(r.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
    expect(r.structuredContent).toEqual(meta);
    expect("data" in (r.structuredContent as object)).toBe(false);
    expect(CallToolResultSchema.safeParse(r).success).toBe(true);
  });
});
