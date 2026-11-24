import { describe, expect, it } from "vitest";
import { setUploadResponseHeaders, UPLOAD_CSP } from "../../src/uploads/service.js";
import { toolResultWithText } from "../../src/mcp/tool-result.js";
import {
  READ_NOTE_IMAGE_DESCRIPTION_SESSION,
  READ_NOTE_IMAGE_DESCRIPTION_TOKEN,
  readNoteImageOutput,
} from "../../src/mcp/tools/read-note-image.js";
import { UPLOAD_NEXT } from "../../src/mcp/tools/create-transfer-token.js";

describe("upload response headers (#389)", () => {
  it("sets nosniff, CSP sandbox (allowing inline styles for SVG CSS animations), immutable cache-control and the stored MIME type", () => {
    const headers = new Map<string, string>();
    let mime = "";
    const reply = {
      header(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
      type(value: string) {
        mime = value;
        return this;
      },
    };

    setUploadResponseHeaders(reply, "image/svg+xml");

    expect(UPLOAD_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(mime).toBe("image/svg+xml");
  });
});

describe("MCP SVG output helpers and schemas (#389)", () => {
  it("toolResultWithText mirrors structuredContent in content[0] and places the raw text in content[1] without an image block", () => {
    const meta = { noteId: "n1", uploadId: "u1", mimeType: "image/svg+xml" as const, bytes: 42 };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const result = toolResultWithText(meta, svg);

    expect(result.structuredContent).toEqual(meta);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(meta) },
      { type: "text", text: svg },
    ]);
  });

  it("readNoteImageOutput accepts image/svg+xml and tool descriptions document SVG text return", () => {
    expect(readNoteImageOutput.mimeType.safeParse("image/svg+xml").success).toBe(true);
    expect(READ_NOTE_IMAGE_DESCRIPTION_TOKEN).toContain("SVG comes back as its UTF-8 XML text");
    expect(READ_NOTE_IMAGE_DESCRIPTION_SESSION).toContain("SVG comes back as its UTF-8 XML text");
    expect(UPLOAD_NEXT).toContain("415: not a PNG, JPEG, GIF, WebP or SVG image");
  });
});
