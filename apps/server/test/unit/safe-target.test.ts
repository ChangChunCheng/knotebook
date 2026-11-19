import { describe, expect, it } from "vitest";
import { safeTarget } from "../../src/lib/safe-target.js";

describe("safeTarget (for the audit log; keeps only origin + pathname)", () => {
  it("with userinfo -> credentials must not appear in the result", () => {
    const out = safeTarget("https://user:pass@evil.example.com/v1");
    expect(out).toBe("https://evil.example.com/v1");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("user");
  });
  it("with query/fragment -> stripped", () => {
    const out = safeTarget("https://example.com/v1?k=secret#frag");
    expect(out).toBe("https://example.com/v1");
    expect(out).not.toContain("secret");
  });
  it("invalid URL -> undefined", () => {
    expect(safeTarget("not a url")).toBeUndefined();
    expect(safeTarget("")).toBeUndefined();
  });
});
