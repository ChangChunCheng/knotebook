import { describe, expect, it } from "vitest";
import { normalizeHandle, validateHandle } from "@knotebook/shared";

/**
 * #122: handle validation and normalisation.
 *
 * Key difference from slugs: **ASCII-only** - a handle is an identity, so typeability across keyboards and avoiding IDN homoglyph
 * confusion come before localisation; normalisation is only the A-Z -> a-z code point mapping, **no transliteration, and not
 * normalizeSlug** (its Unicode lowercase produces combining marks).
 */
describe("normalizeHandle (ASCII lowercase, A-Z -> a-z only)", () => {
  it("upper-case ASCII becomes lower case", () => {
    expect(normalizeHandle("AliCe-Lee2")).toBe("alice-lee2");
  });

  it("non-ASCII characters are kept as is (no transliteration - validateHandle rejects them)", () => {
    expect(normalizeHandle("İstanbul")).toBe("İstanbul");
    expect(normalizeHandle("Ünsal")).toBe("Ünsal");
  });

  it("Turkish dotted capital I must not go through Unicode toLowerCase and produce a combining mark (that is normalizeSlug's behaviour, forbidden here)", () => {
    // misusing String.prototype.toLowerCase() would turn "İ" into "i" + U+0307, two code points
    expect(Array.from(normalizeHandle("İ")).length).toBe(1);
  });

  it("does not trim whitespace (pinned intent): whitespace is kept as is and rejected by the charset check of validateHandle", () => {
    expect(normalizeHandle(" Alice ")).toBe(" alice ");
    expect(validateHandle(normalizeHandle(" Alice "))).toBe("charset");
  });

  it("normalize -> validate: upper-case input is valid after normalisation", () => {
    expect(validateHandle(normalizeHandle("ALICE-Lee2"))).toBeNull();
  });
});

describe("validateHandle (1-32, ^[a-z0-9-]+$, dash rules, not uuid-shaped; no reserved-word list)", () => {
  it("valid: lower-case alphanumerics and inner hyphens", () => {
    expect(validateHandle("alice-lee")).toBeNull();
    expect(validateHandle("a")).toBeNull();
    expect(validateHandle("user-3f2a9c1d")).toBeNull(); // the DB default fallback shape must be valid
    expect(validateHandle("a".repeat(32))).toBeNull();
  });

  it("length: empty string and 33 characters are both rejected", () => {
    expect(validateHandle("")).toBe("length");
    expect(validateHandle("a".repeat(33))).toBe("length");
  });

  it("length is counted in code points (like validateSlug): an emoji string of 34 code units / 17 code points fails charset, not length", () => {
    // reverting the implementation to normalized.length (code units) would return "length" and turn this red: pins the code-point decision
    expect(validateHandle("😀".repeat(17))).toBe("charset");
  });

  it("charset: non-ASCII, underscore, dot, whitespace and upper case (not normalised) are all rejected", () => {
    expect(validateHandle("ünsal")).toBe("charset");
    expect(validateHandle("alice_lee")).toBe("charset");
    expect(validateHandle("alice.lee")).toBe("charset");
    expect(validateHandle("alice lee")).toBe("charset");
    expect(validateHandle("Alice")).toBe("charset");
    // the combining-mark form that dotted capital I produces under a wrong Unicode lowercase is also stopped at the charset check
    expect(validateHandle("i̇stanbul")).toBe("charset");
  });

  it("dash: leading, trailing and consecutive hyphens are rejected", () => {
    expect(validateHandle("-abc")).toBe("dash");
    expect(validateHandle("abc-")).toBe("dash");
    expect(validateHandle("a--b")).toBe("dash");
    expect(validateHandle("-")).toBe("dash");
  });

  it("uuid-shaped is rejected (a full uuid is also too long - the two rules each hold, so asserting non-null is enough)", () => {
    expect(validateHandle("550e8400-e29b-41d4-a716-446655440000")).not.toBeNull();
  });

  it("reverse pin: handle has **no reserved-word list** - api/new/settings/admin/login are valid handles (deliberate: a handle is the second segment under /n/ and /p/, so no route can conflict)", () => {
    for (const word of ["api", "new", "settings", "admin", "login", "notes", "p", "n", "g", "u"]) {
      expect(validateHandle(word), word).toBeNull();
    }
  });
});
