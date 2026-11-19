/**
 * #132: the character gate before strings from unauthenticated endpoints are stored (`oauth/storable.ts`).
 * NUL and lone surrogates are hard errors in PG (text 22021 / jsonb 22P05); without the gate anyone can trigger a 500.
 */
import { describe, expect, it } from "vitest";
import { hasUnstorableChar } from "../../src/oauth/storable.js";

describe("hasUnstorableChar", () => {
  it("blocks NUL and lone surrogates (both high and low)", () => {
    expect(hasUnstorableChar("a\u0000b")).toBe(true);
    expect(hasUnstorableChar("a\uD800b")).toBe(true);
    expect(hasUnstorableChar("a\uDC00b")).toBe(true);
  });

  it("lets paired surrogates and ordinary characters through (over-blocking would reject legitimate names for no visible reason)", () => {
    expect(hasUnstorableChar("plain")).toBe(false);
    expect(hasUnstorableChar("筆記")).toBe(false);
    expect(hasUnstorableChar("emoji \u{1F600}")).toBe(false);
    expect(hasUnstorableChar("\u{10FFFF}")).toBe(false);
    // PG accepts the other control characters, so they're not this gate's job
    expect(hasUnstorableChar("a\u0001b")).toBe(false);
    expect(hasUnstorableChar("")).toBe(false);
  });
});
