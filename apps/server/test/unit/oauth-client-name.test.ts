/**
 * #132: the blacklist for `client_name`. Part of the phishing defence, alongside loopback-only redirect URIs: it blocks characters that can visually push away
 * the "name not verified" note on the consent page.
 */
import { describe, expect, it } from "vitest";
import { hasUnsafeClientNameChar } from "../../src/oauth/client-name.js";

// Build code points with String.fromCodePoint: pasting the characters directly into the source gets distorted when editing or moving it.
const cp = (code: number): string => String.fromCodePoint(code);

describe("hasUnsafeClientNameChar (the visual defence of the consent page)", () => {
  it("lets ordinary names through (including CJK and emoji)", () => {
    expect(hasUnsafeClientNameChar("Claude Code")).toBe(false);
    expect(hasUnsafeClientNameChar("我的腳本 v2")).toBe(false);
    expect(hasUnsafeClientNameChar("tool 🛠")).toBe(false);
  });

  it("blocks C0/C1 control characters", () => {
    expect(hasUnsafeClientNameChar(`a${cp(0x0a)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x00)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x1f)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x7f)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x9f)}b`)).toBe(true);
  });

  it("blocks bidi overrides, zero-width and line-separator characters", () => {
    for (const code of [0x061c, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      expect(hasUnsafeClientNameChar(`app${cp(code)}name`), code.toString(16)).toBe(true);
    }
  });

  // One step outside the boundary must not be blocked: over-blocking makes legitimate names rejected for reasons nobody can trace.
  it("doesn't block valid code points right next to the blacklist boundary", () => {
    for (const code of [0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0x20, 0xa0]) {
      expect(hasUnsafeClientNameChar(`app${cp(code)}name`), code.toString(16)).toBe(false);
    }
  });

  it("an empty string has no unsafe characters (length is handled separately by zod)", () => {
    expect(hasUnsafeClientNameChar("")).toBe(false);
  });
});
