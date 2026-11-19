import { describe, expect, it } from "vitest";
import { BLOCKED_MEDIA_URL, isAllowedEmbedUrl, isSafeMediaUrl, safeMediaUrl } from "./media-url";

const BASE = "http://localhost:5173/notes/abc";

describe("isAllowedEmbedUrl (input side: Embed tab)", () => {
  it("allows complete http(s) URLs", () => {
    expect(isAllowedEmbedUrl("https://example.com/a.png")).toBe(true);
    expect(isAllowedEmbedUrl("http://example.com/a.png")).toBe(true);
  });

  it("rejects dangerous schemes", () => {
    expect(isAllowedEmbedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedEmbedUrl("JavaScript:alert(1)")).toBe(false);
    expect(isAllowedEmbedUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAllowedEmbedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedEmbedUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("deliberately does not auto-complete a scheme: anything without one is rejected", () => {
    expect(isAllowedEmbedUrl("example.com/a.png")).toBe(false);
    expect(isAllowedEmbedUrl("/api/uploads/u1")).toBe(false);
    expect(isAllowedEmbedUrl("")).toBe(false);
  });
});

describe("isSafeMediaUrl (render side)", () => {
  it("allows http(s) and relative URLs - own uploads are /api/uploads/<id>", () => {
    expect(isSafeMediaUrl("https://example.com/a.png", BASE)).toBe(true);
    expect(isSafeMediaUrl("/api/uploads/u1", BASE)).toBe(true);
    expect(isSafeMediaUrl("../uploads/u1", BASE)).toBe(true);
  });

  it("protocol-relative //host/x is allowed - it resolves to a host that is not the own origin", () => {
    // Pins the actual boundary so the wrong impression "relative URL => same origin" does not grow back: this guard guarantees
    // the scheme is http(s), not same origin. External https images are allowed anyway (hotlinking is a known limitation).
    expect(isSafeMediaUrl("//evil.example/x.png", BASE)).toBe(true);
    // The backslash form is equivalent to `/` under a special scheme, so it actually lands on the own origin.
    expect(isSafeMediaUrl("/\\evil.example", BASE)).toBe(true);
  });

  it("empty string is allowed (BlockNote's representation of \"no file yet\", not an attack surface)", () => {
    expect(isSafeMediaUrl("", BASE)).toBe(true);
  });

  it("blocks dangerous schemes written straight into Yjs", () => {
    expect(isSafeMediaUrl("javascript:alert(1)", BASE)).toBe(false);
    expect(isSafeMediaUrl("  javascript:alert(1)", BASE)).toBe(false);
    expect(isSafeMediaUrl("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==", BASE)).toBe(false);
    expect(isSafeMediaUrl("blob:http://localhost:5173/abc", BASE)).toBe(false);
    expect(isSafeMediaUrl("file:///etc/passwd", BASE)).toBe(false);
  });
});

describe("safeMediaUrl", () => {
  it("safe URLs are returned as is; unsafe ones are replaced with an inert about:blank", () => {
    expect(safeMediaUrl("/api/uploads/u1", BASE)).toBe("/api/uploads/u1");
    expect(safeMediaUrl("https://example.com/a.png", BASE)).toBe("https://example.com/a.png");
    expect(safeMediaUrl("javascript:alert(1)", BASE)).toBe(BLOCKED_MEDIA_URL);
  });
});
